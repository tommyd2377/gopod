"use client";

/* eslint-disable @next/next/no-img-element */

import {
  type ChangeEvent,
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  compareEpisodes,
  episodeTimestamp,
  EPISODE_BATCH_SIZE,
  recentEpisodes,
  RECENT_EPISODE_DAYS,
} from "@/lib/episode-catalog";
import type {
  EpisodePlaybackState,
  ParsedEpisode,
  ParsedFeed,
  SavedFeed,
} from "@/lib/types";

const FEEDS_KEY = "podcastFeeds";
const CACHE_KEY = "podcastEpisodesCache";
const PLAYBACK_KEY = "podcastPlaybackState";
const ALL_EPISODES_VIEW = "all";
const BACKUP_VERSION = 1;
const AUTO_REFRESH_STALE_MS = 15 * 60 * 1000;
const FEED_REFRESH_CONCURRENCY = 4;
const PROGRESS_SAVE_INTERVAL_MS = 10_000;
const SKIP_SECONDS = 30;

type FeedCache = Record<string, ParsedFeed>;
type PlaybackMap = Record<string, EpisodePlaybackState>;
type ShowArchive = {
  feedUrl: string;
  episodes: ParsedEpisode[];
  totalEpisodes: number;
  nextOffset: number | null;
};
type ViewKey = typeof ALL_EPISODES_VIEW | string;

type EpisodeWithShow = ParsedEpisode & {
  feedUrl: string;
  showTitle: string;
  showImageUrl?: string;
};

type ActivePlayback = {
  episode: EpisodeWithShow;
  isPaused: boolean;
  key: string;
};

type MediaSessionControls = {
  onPause: MediaSessionActionHandler;
  onPlay: MediaSessionActionHandler;
};

type PodcastBackup = {
  app: "GoPod";
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  podcastFeeds: SavedFeed[];
  podcastEpisodesCache: FeedCache;
  podcastPlaybackState: PlaybackMap;
};

export function GoPodApp() {
  const [hydrated, setHydrated] = useState(false);
  const [feedInput, setFeedInput] = useState("");
  const [feeds, setFeeds] = useState<SavedFeed[]>([]);
  const [cache, setCache] = useState<FeedCache>({});
  const [playback, setPlayback] = useState<PlaybackMap>({});
  const playbackRef = useRef<PlaybackMap>({});
  const [selectedEpisode, setSelectedEpisode] = useState<EpisodeWithShow | null>(null);
  const detailHistoryRestoredRef = useRef(false);
  const listReturnRef = useRef<{ scrollY: number; episodeKey: string } | null>(null);
  const [selectedView, setSelectedView] = useState<ViewKey>(ALL_EPISODES_VIEW);
  const selectedViewRef = useRef<ViewKey>(ALL_EPISODES_VIEW);
  const [episodeLimit, setEpisodeLimit] = useState(EPISODE_BATCH_SIZE);
  const [showArchive, setShowArchive] = useState<ShowArchive | null>(null);
  const [isLoadingArchive, setIsLoadingArchive] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const archiveRequestRef = useRef(0);
  const [isAdding, setIsAdding] = useState(false);
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const [refreshingFeedUrl, setRefreshingFeedUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [isSwitchingView, setIsSwitchingView] = useState(false);
  const autoRefreshStartedRef = useRef(false);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const activeEpisodeRef = useRef<EpisodeWithShow | null>(null);
  const activeEpisodeKeyRef = useRef<string | null>(null);
  const pendingStartTimeRef = useRef<number | null>(null);
  const lastProgressSavedAtRef = useRef(0);
  const importInputRef = useRef<HTMLInputElement>(null);
  const viewSwitchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activePlayback, setActivePlayback] = useState<ActivePlayback | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) {
        return;
      }

      setFeeds(readStorage<SavedFeed[]>(FEEDS_KEY, []));
      setCache(
        pruneFeedCacheToRecentEpisodes(readStorage<FeedCache>(CACHE_KEY, {})),
      );
      playbackRef.current = readStorage<PlaybackMap>(PLAYBACK_KEY, {});
      setPlayback(playbackRef.current);
      setHydrated(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (hydrated) {
      writeStorage(FEEDS_KEY, feeds);
    }
  }, [feeds, hydrated]);

  useEffect(() => {
    if (hydrated) {
      writeStorage(CACHE_KEY, pruneFeedCacheToRecentEpisodes(cache));
    }
  }, [cache, hydrated]);


  useEffect(() => {
    if (!hydrated || autoRefreshStartedRef.current) {
      return;
    }

    autoRefreshStartedRef.current = true;

    if (feeds.length === 0) {
      return;
    }

    async function refreshFeedsOnLoad() {
      const staleFeeds = feeds.filter((feed) =>
        feedNeedsAutoRefresh(feed, cache),
      );

      if (staleFeeds.length === 0) {
        return;
      }

      setIsRefreshingAll(true);
      setError(null);

      const result = await refreshSavedFeeds(feeds, cache, staleFeeds);

      setFeeds(result.nextFeeds);
      setCache(result.nextCache);
      setIsRefreshingAll(false);
    }

    void refreshFeedsOnLoad();
  }, [cache, feeds, hydrated]);

  useEffect(() => {
    function updateScrollTopVisibility() {
      setShowScrollTop(window.scrollY > 520);
    }

    updateScrollTopVisibility();
    window.addEventListener("scroll", updateScrollTopVisibility, {
      passive: true,
    });

    return () => {
      window.removeEventListener("scroll", updateScrollTopVisibility);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (viewSwitchTimerRef.current) {
        clearTimeout(viewSwitchTimerRef.current);
      }
    };
  }, []);

  const storePlayback = useCallback((nextPlayback: PlaybackMap) => {
    playbackRef.current = nextPlayback;
    writeStorage(PLAYBACK_KEY, nextPlayback);
    setPlayback(nextPlayback);
  }, []);

  const saveActiveProgress = useCallback((audio: HTMLAudioElement, force = false) => {
    const episode = activeEpisodeRef.current;

    if (!episode || pendingStartTimeRef.current !== null) {
      return;
    }

    const now = Date.now();

    if (!force && now - lastProgressSavedAtRef.current < PROGRESS_SAVE_INTERVAL_MS) {
      return;
    }

    lastProgressSavedAtRef.current = now;
    const episodeKey = getEpisodeKey(episode);
    const currentPlayback = playbackRef.current;

    storePlayback({
      ...currentPlayback,
      [episodeKey]: {
        ...currentPlayback[episodeKey],
        progress: Math.floor(audio.currentTime || 0),
        duration: Number.isFinite(audio.duration)
          ? Math.floor(audio.duration)
          : currentPlayback[episodeKey]?.duration,
        updatedAt: new Date().toISOString(),
      },
    });
  }, [storePlayback]);

  useEffect(() => {
    function saveBeforeLeaving() {
      if (playerRef.current) {
        saveActiveProgress(playerRef.current, true);
      }
    }

    function saveWhenHidden() {
      if (document.visibilityState === "hidden") {
        saveBeforeLeaving();
      }
    }

    window.addEventListener("pagehide", saveBeforeLeaving);
    document.addEventListener("visibilitychange", saveWhenHidden);
    return () => {
      window.removeEventListener("pagehide", saveBeforeLeaving);
      document.removeEventListener("visibilitychange", saveWhenHidden);
    };
  }, [saveActiveProgress]);

  function pauseAndClearActiveAudio() {
    const player = playerRef.current;

    if (player) {
      saveActiveProgress(player, true);
      player.pause();
      player.removeAttribute("src");
      player.load();
    }

    activeEpisodeRef.current = null;
    activeEpisodeKeyRef.current = null;
    pendingStartTimeRef.current = null;
    setActivePlayback(null);
    clearMediaSession();
  }

  const allEpisodes = useMemo(
    () => buildEpisodeList(feeds, cache),
    [cache, feeds],
  );

  const selectedFeed = feeds.find((feed) => feed.feedUrl === selectedView);
  const selectedArchive = showArchive?.feedUrl === selectedView ? showArchive : null;
  const visibleEpisodes = useMemo(() => {
    if (selectedView === ALL_EPISODES_VIEW) {
      return allEpisodes;
    }

    if (selectedFeed && selectedArchive) {
      return buildEpisodeList([selectedFeed], {
        [selectedView]: { ...selectedFeed, episodes: selectedArchive.episodes },
      }, false);
    }
    return allEpisodes.filter((episode) => episode.feedUrl === selectedView);
  }, [allEpisodes, selectedView, selectedFeed, selectedArchive]);
  const displayedEpisodes = visibleEpisodes.slice(0, episodeLimit);
  const hasMoreEpisodes = visibleEpisodes.length > displayedEpisodes.length ||
    Boolean(selectedArchive && selectedArchive.nextOffset !== null);
  const episodeCount = selectedArchive?.totalEpisodes ?? visibleEpisodes.length;
  const hasLongFeedList = feeds.length > 8;
  const selectedFeedIsRefreshing = Boolean(
    selectedFeed && refreshingFeedUrl === selectedFeed.feedUrl,
  );
  const isActivelyLoadingEpisodes =
    !hydrated || isRefreshingAll || selectedFeedIsRefreshing || isSwitchingView || isLoadingArchive;
  const selectedFeedNeedsRefresh = Boolean(
    hydrated && selectedFeed && !cache[selectedFeed.feedUrl],
  );
  const allEpisodesNeedRefresh = Boolean(
    hydrated &&
      selectedView === ALL_EPISODES_VIEW &&
      feeds.length > 0 &&
      allEpisodes.length === 0 &&
      feeds.some((feed) => !cache[feed.feedUrl]),
  );
  const showEpisodeLoadingState =
    feeds.length > 0 &&
    visibleEpisodes.length === 0 &&
    isActivelyLoadingEpisodes;
  const showEpisodeLoadingStrip =
    feeds.length > 0 &&
    visibleEpisodes.length > 0 &&
    isActivelyLoadingEpisodes;

  useEffect(() => {
    function restoreView() {
      const key = window.history.state?.gopodEpisodeKey;
      setSelectedEpisode(
        allEpisodes.find((episode) => getEpisodeKey(episode) === key) ??
          visibleEpisodes.find((episode) => getEpisodeKey(episode) === key) ??
          (isEpisodeWithShow(window.history.state?.gopodEpisode) &&
            getEpisodeKey(window.history.state.gopodEpisode) === key
            ? window.history.state.gopodEpisode : null) ??
          (activeEpisodeKeyRef.current === key ? activeEpisodeRef.current : null),
      );
    }

    if (hydrated && !detailHistoryRestoredRef.current) {
      detailHistoryRestoredRef.current = true;
      restoreView();
    }
    window.addEventListener("popstate", restoreView);
    return () => window.removeEventListener("popstate", restoreView);
  }, [allEpisodes, visibleEpisodes, hydrated]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (selectedEpisode) {
        window.scrollTo({ top: 0, behavior: "instant" });
        document.getElementById("episode-detail-title")?.focus({ preventScroll: true });
      } else if (listReturnRef.current) {
        const { scrollY, episodeKey } = listReturnRef.current;
        window.scrollTo({ top: scrollY, behavior: "instant" });
        document.getElementById(`${getEpisodeElementId(episodeKey)}-details`)
          ?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedEpisode]);

  function openEpisodeDetails(episode: EpisodeWithShow) {
    const episodeKey = getEpisodeKey(episode);
    if (!selectedEpisode) {
      listReturnRef.current = { scrollY: window.scrollY, episodeKey };
    }
    const nextState = {
      ...window.history.state,
      gopodEpisodeKey: episodeKey,
      gopodEpisode: episode,
    };
    const url = `#${getEpisodeElementId(episodeKey)}`;
    if (selectedEpisode) {
      window.history.replaceState(nextState, "", url);
    } else {
      window.history.pushState(nextState, "", url);
    }
    setSelectedEpisode(episode);
  }

  function closeEpisodeDetails() {
    if (window.history.state?.gopodEpisodeKey) {
      window.history.back();
    } else {
      setSelectedEpisode(null);
    }
  }

  async function playEpisode(episode: EpisodeWithShow) {
    const player = playerRef.current;

    if (!player) {
      setError("Audio player is still loading.");
      return;
    }

    const episodeKey = getEpisodeKey(episode);
    const isSameEpisode = activeEpisodeKeyRef.current === episodeKey;

    setError(null);

    if (!isSameEpisode) {
      saveActiveProgress(player, true);
      player.pause();
      activeEpisodeRef.current = episode;
      activeEpisodeKeyRef.current = episodeKey;
      pendingStartTimeRef.current = playback[episodeKey]?.progress ?? 0;
      lastProgressSavedAtRef.current = 0;
      player.src = episode.audioUrl;
      player.load();
    } else {
      activeEpisodeRef.current = episode;
    }

    setActivePlayback({
      episode,
      isPaused: false,
      key: episodeKey,
    });
    updateActiveMediaSession(episode, player);

    try {
      await player.play();
      updateMediaSessionState(player, "playing");
    } catch {
      setActivePlayback({
        episode,
        isPaused: true,
        key: episodeKey,
      });
      updateMediaSessionState(player, "paused");
      setError("Unable to start playback.");
    }
  }

  function handlePlayerPlay() {
    const player = playerRef.current;
    const episode = activeEpisodeRef.current;

    if (!player || !episode) {
      return;
    }

    const episodeKey = getEpisodeKey(episode);
    activeEpisodeKeyRef.current = episodeKey;
    setActivePlayback({
      episode,
      isPaused: false,
      key: episodeKey,
    });
    updateActiveMediaSession(episode, player);
  }

  function handlePlayerPause(audio: HTMLAudioElement) {
    const episode = activeEpisodeRef.current;

    if (!episode) {
      return;
    }

    saveActiveProgress(audio, true);
    setActivePlayback((currentPlayback) =>
      currentPlayback
        ? {
            ...currentPlayback,
            isPaused: true,
          }
        : currentPlayback,
    );
    updateActiveMediaSession(episode, audio);
  }

  function handlePlayerEnded(audio: HTMLAudioElement) {
    const episode = activeEpisodeRef.current;

    if (episode) {
      const episodeKey = getEpisodeKey(episode);

      const currentPlayback = playbackRef.current;
      const duration = Math.floor(
        Number.isFinite(audio.duration) ? audio.duration : audio.currentTime || 0,
      );
      storePlayback({
        ...currentPlayback,
        [episodeKey]: {
          ...currentPlayback[episodeKey],
          played: true,
          progress: duration,
          duration,
          updatedAt: new Date().toISOString(),
        },
      });
    }

    updateMediaSessionState(audio, "none");
    activeEpisodeRef.current = null;
    activeEpisodeKeyRef.current = null;
    pendingStartTimeRef.current = null;
    setActivePlayback(null);
  }

  function handlePlayerLoadedMetadata(audio: HTMLAudioElement) {
    const episode = activeEpisodeRef.current;

    if (!episode) {
      return;
    }

    const progress =
      pendingStartTimeRef.current ?? playback[getEpisodeKey(episode)]?.progress ?? 0;
    const duration = audio.duration;

    if (progress > 0 && (!duration || progress < duration - 2)) {
      audio.currentTime = progress;
    }

    pendingStartTimeRef.current = null;
    updateMediaSessionPosition(audio);
  }

  function handlePlayerTimeUpdate(audio: HTMLAudioElement) {
    saveActiveProgress(audio);
    updateMediaSessionPosition(audio);
  }

  function updateActiveMediaSession(
    episode: EpisodeWithShow,
    audio: HTMLAudioElement,
  ) {
    updateMediaSession(episode, audio, {
      onPause: () => pauseActiveAudio(audio),
      onPlay: () => {
        void resumeActiveAudio(audio);
      },
    });
  }

  function pauseActiveAudio(audio = playerRef.current) {
    const episode = activeEpisodeRef.current;

    if (!audio || !episode) {
      return;
    }

    saveActiveProgress(audio, true);
    audio.pause();
    setActivePlayback((currentPlayback) =>
      currentPlayback
        ? {
            ...currentPlayback,
            isPaused: true,
          }
        : currentPlayback,
    );
    updateActiveMediaSession(episode, audio);
  }

  async function resumeActiveAudio(audio = playerRef.current) {
    const episode = activeEpisodeRef.current;

    if (!audio || !episode) {
      setActivePlayback(null);
      activeEpisodeKeyRef.current = null;
      return;
    }

    const episodeKey = getEpisodeKey(episode);
    const savedProgress = playback[episodeKey]?.progress ?? 0;
    const resumeTime = Math.floor(audio.currentTime || savedProgress || 0);

    setError(null);
    activeEpisodeKeyRef.current = episodeKey;

    if (!audioHasEpisodeSource(audio, episode) || audio.error) {
      pendingStartTimeRef.current = resumeTime;
      audio.src = episode.audioUrl;
      audio.load();
    } else if (audio.readyState === audio.HAVE_NOTHING) {
      pendingStartTimeRef.current = resumeTime;
      audio.load();
    } else if (audio.ended) {
      audio.currentTime =
        savedProgress > 0 &&
        Number.isFinite(audio.duration) &&
        savedProgress < audio.duration - 2
          ? savedProgress
          : 0;
    }

    setActivePlayback({
      episode,
      isPaused: false,
      key: episodeKey,
    });
    updateActiveMediaSession(episode, audio);

    try {
      await audio.play();
      updateMediaSessionState(audio, "playing");
    } catch {
      setActivePlayback({
        episode,
        isPaused: true,
        key: episodeKey,
      });
      updateActiveMediaSession(episode, audio);
      setError("Unable to resume playback.");
    }
  }

  function toggleActivePlayback() {
    const player = playerRef.current;

    if (!player || !activeEpisodeRef.current) {
      setActivePlayback(null);
      activeEpisodeKeyRef.current = null;
      return;
    }

    if (player.paused) {
      void resumeActiveAudio(player);
      return;
    }

    pauseActiveAudio(player);
  }

  function jumpToActiveEpisode() {
    if (activeEpisodeRef.current) {
      openEpisodeDetails(activeEpisodeRef.current);
    }
  }

  async function addFeed(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextFeedUrl = feedInput.trim();

    if (!nextFeedUrl) {
      setError("Paste a podcast RSS feed URL first.");
      setMessage(null);
      return;
    }

    setIsAdding(true);
    setError(null);
    setMessage(null);

    try {
      const parsedFeed = await loadFeed(nextFeedUrl);
      const savedFeed = toSavedFeed(parsedFeed);

      setFeeds((currentFeeds) => {
        const withoutExisting = currentFeeds.filter(
          (feed) => feed.feedUrl !== savedFeed.feedUrl,
        );
        return [...withoutExisting, savedFeed].sort((a, b) =>
          a.title.localeCompare(b.title),
        );
      });
      setCache((currentCache) => ({
        ...currentCache,
        [savedFeed.feedUrl]: parsedFeed,
      }));
      selectView(savedFeed.feedUrl);
      setFeedInput("");
      setMessage(`Added ${savedFeed.title}.`);
    } catch (feedError) {
      setError(getErrorMessage(feedError));
    } finally {
      setIsAdding(false);
    }
  }

  async function refreshFeed(feedUrl: string) {
    const savedFeed = feeds.find((feed) => feed.feedUrl === feedUrl);

    if (!savedFeed) {
      return;
    }

    setRefreshingFeedUrl(feedUrl);
    setError(null);
    setMessage(null);

    try {
      const parsedFeed = await loadFeed(feedUrl);
      const nextSavedFeed = toSavedFeed(parsedFeed);

      setFeeds((currentFeeds) =>
        currentFeeds.map((feed) =>
          feed.feedUrl === feedUrl ? nextSavedFeed : feed,
        ),
      );
      setCache((currentCache) => ({
        ...currentCache,
        [nextSavedFeed.feedUrl]: parsedFeed,
      }));
      if (selectedViewRef.current === feedUrl) {
        void loadShowArchive(feedUrl);
      }
      setMessage(`Refreshed ${nextSavedFeed.title}.`);
    } catch (feedError) {
      setError(getErrorMessage(feedError));
    } finally {
      setRefreshingFeedUrl(null);
    }
  }

  async function refreshAllFeeds() {
    if (feeds.length === 0) {
      setError("Add your first podcast RSS feed.");
      setMessage(null);
      return;
    }

    setIsRefreshingAll(true);
    setError(null);
    setMessage(null);

    const result = await refreshSavedFeeds(feeds, cache, feeds);

    setFeeds(result.nextFeeds);
    setCache(result.nextCache);
    setIsRefreshingAll(false);
    if (selectedViewRef.current !== ALL_EPISODES_VIEW) {
      void loadShowArchive(selectedViewRef.current);
    }

    if (result.failedFeeds.length > 0) {
      setError(getRefreshFailureMessage(result.failedFeeds.length));
    } else {
      setMessage("All feeds refreshed.");
    }
  }

  function removeFeed(feedUrl: string) {
    const feed = feeds.find((candidate) => candidate.feedUrl === feedUrl);

    if (activePlayback?.episode.feedUrl === feedUrl) {
      pauseAndClearActiveAudio();
    }

    setFeeds((currentFeeds) =>
      currentFeeds.filter((candidate) => candidate.feedUrl !== feedUrl),
    );
    setCache((currentCache) => {
      const nextCache = { ...currentCache };
      delete nextCache[feedUrl];
      return nextCache;
    });

    if (selectedView === feedUrl) {
      resetShowArchive();
      selectedViewRef.current = ALL_EPISODES_VIEW;
      setSelectedView(ALL_EPISODES_VIEW);
      setEpisodeLimit(EPISODE_BATCH_SIZE);
    }

    setMessage(feed ? `Removed ${feed.title}.` : null);
    setError(null);
  }

  function resetShowArchive() {
    archiveRequestRef.current += 1;
    setShowArchive(null);
    setArchiveError(null);
    setIsLoadingArchive(false);
  }

  async function loadShowArchive(feedUrl: string, offset = 0) {
    const requestId = ++archiveRequestRef.current;
    setIsLoadingArchive(true);
    setArchiveError(null);
    if (offset === 0) {
      setShowArchive(null);
      setEpisodeLimit(EPISODE_BATCH_SIZE);
    }
    try {
      const page = await loadFeed(feedUrl, offset);
      if (requestId !== archiveRequestRef.current) {
        return;
      }
      setShowArchive((current) => {
        const previous = offset > 0 && current?.feedUrl === feedUrl
          ? current.episodes : [];
        const episodes = Array.from(new Map(
          [...previous, ...page.episodes].map((episode) => [getEpisodeKey(episode), episode]),
        ).values());
        return {
          feedUrl,
          episodes,
          totalEpisodes: page.totalEpisodes ?? episodes.length,
          nextOffset: page.nextOffset ?? null,
        };
      });
      if (offset > 0) {
        setEpisodeLimit((current) => current + EPISODE_BATCH_SIZE);
      }
    } catch (feedError) {
      if (requestId === archiveRequestRef.current) {
        setArchiveError(getErrorMessage(feedError));
      }
    } finally {
      if (requestId === archiveRequestRef.current) {
        setIsLoadingArchive(false);
      }
    }
  }

  function showMoreEpisodes() {
    if (displayedEpisodes.length < visibleEpisodes.length) {
      setEpisodeLimit((current) => current + EPISODE_BATCH_SIZE);
    } else if (selectedArchive && selectedArchive.nextOffset !== null) {
      void loadShowArchive(selectedArchive.feedUrl, selectedArchive.nextOffset);
    }
  }

  function selectView(view: ViewKey) {
    if (viewSwitchTimerRef.current) {
      clearTimeout(viewSwitchTimerRef.current);
    }

    setIsSwitchingView(true);
    selectedViewRef.current = view;
    setSelectedView(view);
    setEpisodeLimit(EPISODE_BATCH_SIZE);
    if (view === ALL_EPISODES_VIEW) {
      resetShowArchive();
    } else {
      void loadShowArchive(view);
    }
    viewSwitchTimerRef.current = setTimeout(() => {
      setIsSwitchingView(false);
    }, 180);
  }

  function exportData() {
    const backup: PodcastBackup = {
      app: "GoPod",
      exportedAt: new Date().toISOString(),
      podcastEpisodesCache: cache,
      podcastFeeds: feeds,
      podcastPlaybackState: playback,
      version: BACKUP_VERSION,
    };
    const exportedAt = backup.exportedAt.slice(0, 10);
    const blob = new Blob([JSON.stringify(backup, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `gopod-backup-${exportedAt}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setError(null);
    setMessage(`Exported ${feeds.length} saved feeds.`);
  }

  function openImportPicker() {
    importInputRef.current?.click();
  }

  async function importData(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    setError(null);
    setMessage(null);

    try {
      const backup = parseBackup(await file.text());
      const hasExistingData =
        feeds.length > 0 ||
        Object.keys(cache).length > 0 ||
        Object.keys(playback).length > 0;

      if (
        hasExistingData &&
        !window.confirm("Import this backup and replace local podcast data?")
      ) {
        return;
      }

      setFeeds([...backup.podcastFeeds].sort(sortFeedsByTitle));
      setCache(backup.podcastEpisodesCache);
      resetShowArchive();
      storePlayback(backup.podcastPlaybackState);
      selectedViewRef.current = ALL_EPISODES_VIEW;
      setSelectedView(ALL_EPISODES_VIEW);
      setEpisodeLimit(EPISODE_BATCH_SIZE);
      setMessage(`Imported ${backup.podcastFeeds.length} saved feeds.`);
    } catch (backupError) {
      setError(getErrorMessage(backupError));
    }
  }

  function scrollToTop() {
    window.scrollTo({
      behavior: "smooth",
      top: 0,
    });
  }

  return (
    <main className="app-shell">
      <div hidden={Boolean(selectedEpisode)}>
      <header className="app-header">
        <div>
          <p className="eyebrow">Local RSS player</p>
          <BrandTitle />
        </div>
        <button
          className="button secondary-button"
          disabled={isRefreshingAll || feeds.length === 0}
          onClick={refreshAllFeeds}
          type="button"
        >
          {isRefreshingAll ? "Refreshing..." : "Refresh All"}
        </button>
      </header>

      <form className="feed-form" onSubmit={addFeed}>
        <label className="sr-only" htmlFor="feed-url">
          Podcast RSS feed URL
        </label>
        <input
          autoCapitalize="none"
          autoComplete="url"
          autoCorrect="off"
          id="feed-url"
          inputMode="url"
          onChange={(event) => setFeedInput(event.target.value)}
          placeholder="Paste podcast RSS feed URL"
          type="url"
          value={feedInput}
        />
        <button className="button primary-button" disabled={isAdding} type="submit">
          {isAdding ? "Adding..." : "Add Feed"}
        </button>
      </form>

      <section className="backup-tools" aria-label="Local backup tools">
        <div>
          <p className="eyebrow">Backup</p>
          <h2>Local data</h2>
        </div>
        <div className="backup-actions">
          <button
            className="button secondary-button compact-action"
            disabled={!hydrated}
            onClick={exportData}
            type="button"
          >
            Export
          </button>
          <button
            className="button secondary-button compact-action"
            disabled={!hydrated}
            onClick={openImportPicker}
            type="button"
          >
            Import
          </button>
          <input
            accept="application/json,.json"
            className="sr-only"
            onChange={importData}
            ref={importInputRef}
            type="file"
          />
        </div>
      </section>

      {(error || message) && (
        <p className={error ? "notice error-notice" : "notice success-notice"}>
          {error ?? message}
        </p>
      )}

      <div className="content-grid">
        <aside className="shows-panel" aria-label="Saved shows">
          <div className="panel-heading">
            <h2>Shows</h2>
            <span>{feeds.length}</span>
          </div>

          {hasLongFeedList && (
            <label className="show-picker">
              <span>Jump to show</span>
              <select
                onChange={(event) => selectView(event.target.value)}
                value={selectedView}
              >
                <option value={ALL_EPISODES_VIEW}>
                  All Episodes ({allEpisodes.length})
                </option>
                {feeds.map((feed) => (
                  <option key={feed.feedUrl} value={feed.feedUrl}>
                    {feed.title}
                  </option>
                ))}
              </select>
            </label>
          )}

          <button
            className={`show-button all-episodes-button ${
              selectedView === ALL_EPISODES_VIEW ? "active" : ""
            }`}
            onClick={() => selectView(ALL_EPISODES_VIEW)}
            type="button"
          >
            <span className="show-art text-art">All</span>
            <span>
              <strong>All Episodes</strong>
              <small>{allEpisodes.length} episodes</small>
            </span>
          </button>

          <nav className="show-list" aria-label="Podcast views">
            {feeds.map((feed) => (
              <div className="show-row" key={feed.feedUrl}>
                <button
                  className={`show-button ${
                    selectedView === feed.feedUrl ? "active" : ""
                  }`}
                  onClick={() => selectView(feed.feedUrl)}
                  type="button"
                >
                  <ShowArt feed={feed} />
                  <span>
                    <strong>{feed.title}</strong>
                    <small>{getFeedEpisodeLabel(feed, cache, refreshingFeedUrl)}</small>
                  </span>
                </button>
                <div className="show-actions">
                  <button
                    className="text-button"
                    disabled={refreshingFeedUrl === feed.feedUrl}
                    onClick={() => refreshFeed(feed.feedUrl)}
                    type="button"
                  >
                    {refreshingFeedUrl === feed.feedUrl ? "..." : "Refresh"}
                  </button>
                  <button
                    className="text-button remove-button"
                    onClick={() => removeFeed(feed.feedUrl)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <section className="episodes-panel" aria-live="polite">
          <div className="episodes-heading">
            <div>
              <p className="eyebrow">
                {selectedFeed ? selectedFeed.title : "All Episodes"}
              </p>
              <h2>
                {showEpisodeLoadingState
                  ? "Loading episodes"
                  : episodeCount === 1
                  ? "1 episode"
                  : `${episodeCount} episodes`}
              </h2>
            </div>
          </div>

          {hydrated && feeds.length > 0 && (
            <p className="episode-scope">
              {selectedFeed
                ? "Browse this show’s available episodes, newest first."
                : `New episodes from the last ${RECENT_EPISODE_DAYS} days.`}
            </p>
          )}

          {!hydrated && <EmptyState text="Loading your saved feeds." />}

          {showEpisodeLoadingStrip && (
            <LoadingState text={getLoadingMessage(isRefreshingAll, selectedFeed)} />
          )}

          {hydrated && feeds.length === 0 && (
            <EmptyState text="Add your first podcast RSS feed." />
          )}

          {showEpisodeLoadingState && (
            <LoadingState text={getLoadingMessage(isRefreshingAll, selectedFeed)} />
          )}

          {hydrated &&
            feeds.length > 0 &&
            visibleEpisodes.length === 0 &&
            !showEpisodeLoadingState &&
            (selectedFeedNeedsRefresh || allEpisodesNeedRefresh) && (
              <EmptyState text="Refresh to load episodes." />
            )}

          {hydrated &&
            feeds.length > 0 &&
            visibleEpisodes.length === 0 &&
            !showEpisodeLoadingState &&
            !selectedFeedNeedsRefresh &&
            !allEpisodesNeedRefresh &&
            !archiveError && (
            <EmptyState text={selectedFeed
              ? "No episodes found in this feed."
              : `No episodes published in the last ${RECENT_EPISODE_DAYS} days. Open a show to browse older episodes.`} />
          )}

          {archiveError && selectedFeed && (
            <div className="notice error-notice" role="alert">
              <p>{archiveError}</p>
              <button
                className="button secondary-button"
                onClick={() => loadShowArchive(selectedFeed.feedUrl, selectedArchive?.nextOffset ?? 0)}
                type="button"
              >
                Try again
              </button>
            </div>
          )}

          <div className="episode-list">
            {displayedEpisodes.map((episode) => (
              <EpisodeCard
                activePlayback={activePlayback}
                episode={episode}
                key={`${episode.feedUrl}:${getEpisodeKey(episode)}`}
                onPlayEpisode={playEpisode}
                onOpenDetails={openEpisodeDetails}
                onToggleActivePlayback={toggleActivePlayback}
                playbackState={playback[getEpisodeKey(episode)]}
              />
            ))}

            {hasMoreEpisodes && (
              <button
                className="button secondary-button load-more-button"
                disabled={isLoadingArchive}
                onClick={showMoreEpisodes}
                type="button"
              >
                {isLoadingArchive ? "Loading episodes..." : selectedFeed ? "Load older episodes" : "Show more"}
              </button>
            )}
          </div>
        </section>
      </div>

      </div>

      {selectedEpisode && error && (
        <p className="notice error-notice" role="alert">{error}</p>
      )}
      {selectedEpisode && (
        <EpisodeDetails
          activePlayback={activePlayback}
          episode={selectedEpisode}
          onBack={closeEpisodeDetails}
          onPlayEpisode={playEpisode}
          onToggleActivePlayback={toggleActivePlayback}
          playbackState={playback[getEpisodeKey(selectedEpisode)]}
        />
      )}

      <NowPlayingBar
        activePlayback={activePlayback}
        audioRef={playerRef}
        onAudioEnded={handlePlayerEnded}
        onAudioLoadedMetadata={handlePlayerLoadedMetadata}
        onAudioPause={handlePlayerPause}
        onAudioPlay={handlePlayerPlay}
        onAudioTimeUpdate={handlePlayerTimeUpdate}
        onAudioSeeked={(audio) => saveActiveProgress(audio, true)}
        onJump={jumpToActiveEpisode}
        onTogglePlayback={toggleActivePlayback}
        onScrollToTop={scrollToTop}
        showScrollTop={showScrollTop}
      />
    </main>
  );
}

function BrandTitle() {
  return (
    <h1 className="brand-title" aria-label="GoPod">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 64 64" focusable="false">
          <path d="M20 30c8 0 15 7 15 15" />
          <path d="M20 17c16 0 28 12 28 28" />
          <circle cx="20" cy="45" r="5.5" />
        </svg>
      </span>
      <span className="brand-word" aria-hidden="true">
        <span>Go</span>
        <span>Pod</span>
      </span>
    </h1>
  );
}

function PlaybackIcon({ paused }: { paused: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      {paused ? <path d="M8 4.5v15l12-7.5z" /> : <path d="M6 4h4v16H6zm8 0h4v16h-4z" />}
    </svg>
  );
}

function EpisodeArt({ episode, className = "" }: {
  episode: EpisodeWithShow;
  className?: string;
}) {
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const imageUrl = [episode.imageUrl, episode.showImageUrl].find(
    (url) => url && !failedUrls.includes(url),
  );

  return imageUrl ? (
    <img
      alt=""
      className={`episode-art ${className}`}
      loading="lazy"
      onError={() => setFailedUrls((current) => [...current, imageUrl])}
      src={imageUrl}
    />
  ) : (
    <span aria-hidden="true" className={`episode-art text-art ${className}`}>
      {episode.showTitle.slice(0, 2)}
    </span>
  );
}

function EpisodeTime({ episode, playbackState }: {
  episode: ParsedEpisode;
  playbackState?: EpisodePlaybackState;
}) {
  const duration = playbackState?.duration || parseDuration(episode.duration);
  return (
    <span className="episode-time">
      {formatProgress(playbackState?.progress ?? 0)} / {duration ? formatProgress(duration) : "—"}
      <span className="time-caption"> listened</span>
    </span>
  );
}

function EpisodePlayButton({ activePlayback, episode, playbackState, onPlayEpisode, onToggleActivePlayback }: {
  activePlayback: ActivePlayback | null;
  episode: EpisodeWithShow;
  playbackState?: EpisodePlaybackState;
  onPlayEpisode: (episode: EpisodeWithShow) => void;
  onToggleActivePlayback: () => void;
}) {
  const isCurrentEpisode = activePlayback?.key === getEpisodeKey(episode);
  const isPlaying = isCurrentEpisode && !activePlayback?.isPaused;
  const label = getEpisodePlayLabel(isCurrentEpisode, activePlayback, playbackState);
  return (
    <button
      aria-label={`${label} ${episode.title}`}
      className="button primary-button episode-play-button"
      onClick={() => isPlaying ? onToggleActivePlayback() : onPlayEpisode(episode)}
      title={label}
      type="button"
    >
      <PlaybackIcon paused={!isPlaying} />
    </button>
  );
}

function EpisodeCard({
  activePlayback, episode, onPlayEpisode, onOpenDetails,
  onToggleActivePlayback, playbackState,
}: {
  activePlayback: ActivePlayback | null;
  episode: EpisodeWithShow;
  onPlayEpisode: (episode: EpisodeWithShow) => void;
  onOpenDetails: (episode: EpisodeWithShow) => void;
  onToggleActivePlayback: () => void;
  playbackState?: EpisodePlaybackState;
}) {
  const description = getDescriptionPreview(episode.description);
  const episodeId = getEpisodeElementId(getEpisodeKey(episode));
  return (
    <article className="episode-card" id={episodeId}>
      <div className="episode-card-heading">
        <EpisodeArt episode={episode} />
        <div className="episode-card-copy">
          <p className="episode-show">{episode.showTitle}</p>
          <div className="episode-meta">
            <span>{formatDate(episode.pubDate)}</span>
            <EpisodeTime episode={episode} playbackState={playbackState} />
          </div>
        </div>
        <EpisodePlayButton
          activePlayback={activePlayback} episode={episode} playbackState={playbackState}
          onPlayEpisode={onPlayEpisode} onToggleActivePlayback={onToggleActivePlayback}
        />
      </div>
      <h3>
        <button
          aria-label={`View details for ${episode.title}`}
          className="episode-title-button"
          id={`${episodeId}-details`}
          onClick={() => onOpenDetails(episode)}
          type="button"
        >
          {episode.title}
        </button>
      </h3>
      {description && <p className="episode-description">{description}</p>}
    </article>
  );
}

function EpisodeDetails({ activePlayback, episode, onBack, onPlayEpisode, onToggleActivePlayback, playbackState }: {
  activePlayback: ActivePlayback | null;
  episode: EpisodeWithShow;
  onBack: () => void;
  onPlayEpisode: (episode: EpisodeWithShow) => void;
  onToggleActivePlayback: () => void;
  playbackState?: EpisodePlaybackState;
}) {
  return (
    <section className="episode-detail" aria-labelledby="episode-detail-title">
      <button className="button primary-button detail-back-button" onClick={onBack} type="button">
        <span aria-hidden="true">←</span> Back
      </button>
      <div className="episode-detail-heading">
        <EpisodeArt episode={episode} className="episode-detail-art" />
        <div>
          <p className="eyebrow">{episode.showTitle}</p>
          <div className="episode-meta">
            <span>{formatDate(episode.pubDate)}</span>
            <EpisodeTime episode={episode} playbackState={playbackState} />
          </div>
        </div>
        <EpisodePlayButton
          activePlayback={activePlayback} episode={episode} playbackState={playbackState}
          onPlayEpisode={onPlayEpisode} onToggleActivePlayback={onToggleActivePlayback}
        />
      </div>
      <h1 id="episode-detail-title" tabIndex={-1}>{episode.title}</h1>
      <div className="episode-full-description">
        {getDescriptionText(episode.description) || "No description available for this episode."}
      </div>
    </section>
  );
}

function SkipIcon({ forward = false }: { forward?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" focusable="false">
      <g transform={forward ? "translate(32 0) scale(-1 1)" : undefined}>
        <path d="M9 8a11 11 0 1 1-3.5 10M9 3v7H2" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <text x="16" y="22" textAnchor="middle" fill="currentColor" fontSize="12" fontWeight="800">30</text>
    </svg>
  );
}

function NowPlayingBar({
  activePlayback, audioRef, onAudioEnded, onAudioLoadedMetadata, onAudioPause,
  onAudioPlay, onAudioTimeUpdate, onAudioSeeked, onJump, onTogglePlayback,
  onScrollToTop, showScrollTop,
}: {
  activePlayback: ActivePlayback | null;
  audioRef: RefObject<HTMLAudioElement | null>;
  onAudioEnded: (audio: HTMLAudioElement) => void;
  onAudioLoadedMetadata: (audio: HTMLAudioElement) => void;
  onAudioPause: (audio: HTMLAudioElement) => void;
  onAudioPlay: () => void;
  onAudioTimeUpdate: (audio: HTMLAudioElement) => void;
  onAudioSeeked: (audio: HTMLAudioElement) => void;
  onJump: () => void;
  onTogglePlayback: () => void;
  onScrollToTop: () => void;
  showScrollTop: boolean;
}) {
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const dockRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) {
      return;
    }
    function reserveDockSpace() {
      document.documentElement.style.setProperty(
        "--player-height", `${dock!.getBoundingClientRect().height}px`,
      );
    }
    reserveDockSpace();
    const observer = new ResizeObserver(reserveDockSpace);
    observer.observe(dock);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--player-height");
    };
  }, []);

  function syncPosition(audio: HTMLAudioElement) {
    setPosition(audio.currentTime || 0);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
  }

  function seekTo(seconds: number) {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) {
      return;
    }
    audio.currentTime = Math.max(0, Math.min(audio.duration, seconds));
    syncPosition(audio);
    onAudioSeeked(audio);
  }

  return (
    <aside
      aria-label={activePlayback ? "Now playing" : "Page navigation"}
      className={`now-playing-bar ${activePlayback ? "" : "navigation-only"}`}
      hidden={!activePlayback && !showScrollTop}
      ref={dockRef}
    >
      <div className="now-playing-header">
        {activePlayback && (
          <EpisodeArt episode={activePlayback.episode} className="player-art" />
        )}
        <button className="now-playing-copy" hidden={!activePlayback} onClick={onJump} type="button"
          aria-label={`View details for ${activePlayback?.episode.title ?? "current episode"}`}>
          <span>{activePlayback?.episode.showTitle ?? "GoPod"}</span>
          <strong>{activePlayback?.episode.title ?? "No episode selected"}</strong>
        </button>
        <button
          aria-label="Scroll to top"
          aria-hidden={!showScrollTop}
          className={`scroll-top-button ${showScrollTop ? "" : "top-button-hidden"}`}
          onClick={(event) => {
            // The dock can hide during the scroll; release focus before that happens.
            event.currentTarget.blur();
            onScrollToTop();
          }}
          tabIndex={showScrollTop ? 0 : -1}
          type="button"
        >
          <span aria-hidden="true">↑</span> Top
        </button>
      </div>
      <div className="player-timeline" hidden={!activePlayback}>
        <span>{formatProgress(position)}</span>
        <input aria-label="Playback position" aria-valuetext={`${formatProgress(position)} of ${formatProgress(duration)}`}
          disabled={!duration} max={duration || 1} min={0} onChange={(event) => seekTo(Number(event.target.value))}
          step={1} type="range" value={Math.min(position, duration)} />
        <span>{formatProgress(duration)}</span>
      </div>
      <div className="now-playing-actions" hidden={!activePlayback}>
        <button aria-label="Back 30 seconds" className="player-skip-button" disabled={!activePlayback || !duration}
          onClick={() => seekTo((audioRef.current?.currentTime ?? 0) - SKIP_SECONDS)} type="button">
          <SkipIcon />
        </button>
        <button aria-label={activePlayback?.isPaused ? "Resume playback" : "Pause playback"}
          className="button primary-button player-play-button" disabled={!activePlayback}
          onClick={onTogglePlayback} type="button">
          <PlaybackIcon paused={activePlayback?.isPaused ?? true} />
        </button>
        <button aria-label="Forward 30 seconds" className="player-skip-button" disabled={!activePlayback || !duration}
          onClick={() => seekTo((audioRef.current?.currentTime ?? 0) + SKIP_SECONDS)} type="button">
          <SkipIcon forward />
        </button>
      </div>
      <audio
        onDurationChange={(event) => syncPosition(event.currentTarget)}
        onEmptied={(event) => syncPosition(event.currentTarget)}
        onEnded={(event) => onAudioEnded(event.currentTarget)}
        onLoadedMetadata={(event) => { onAudioLoadedMetadata(event.currentTarget); syncPosition(event.currentTarget); }}
        onPause={(event) => onAudioPause(event.currentTarget)}
        onPlay={onAudioPlay}
        onSeeked={(event) => { syncPosition(event.currentTarget); onAudioSeeked(event.currentTarget); }}
        onTimeUpdate={(event) => { syncPosition(event.currentTarget); onAudioTimeUpdate(event.currentTarget); }}
        playsInline preload="none" ref={audioRef}
      />
    </aside>
  );
}

function ShowArt({ feed }: { feed: SavedFeed }) {
  if (feed.imageUrl) {
    return <img alt="" className="show-art" src={feed.imageUrl} />;
  }

  return <span className="show-art text-art">{feed.title.slice(0, 2)}</span>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

function LoadingState({ text }: { text: string }) {
  return (
    <div className="loading-state">
      <span className="loading-spinner" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

function getLoadingMessage(isRefreshingAll: boolean, selectedFeed?: SavedFeed) {
  if (isRefreshingAll) {
    return "Refreshing feeds...";
  }

  if (selectedFeed) {
    return "Loading episodes...";
  }

  return "Loading all episodes...";
}

function getRefreshFailureMessage(failedFeedCount: number) {
  return failedFeedCount === 1
    ? "Could not refresh 1 feed. Showing saved episodes where available."
    : `Could not refresh ${failedFeedCount} feeds. Showing saved episodes where available.`;
}

function getFeedEpisodeLabel(
  feed: SavedFeed,
  cache: FeedCache,
  refreshingFeedUrl: string | null,
) {
  if (refreshingFeedUrl === feed.feedUrl) {
    return "Refreshing...";
  }

  const episodeCount = cache[feed.feedUrl]?.totalEpisodes ?? cache[feed.feedUrl]?.episodes.length;

  if (typeof episodeCount !== "number") {
    return "Not loaded";
  }

  return episodeCount === 1 ? "1 episode" : `${episodeCount} episodes`;
}

function getEpisodePlayLabel(
  isCurrentEpisode: boolean,
  activePlayback: ActivePlayback | null,
  playbackState?: EpisodePlaybackState,
) {
  if (isCurrentEpisode) {
    return activePlayback?.isPaused ? "Resume" : "Pause";
  }

  return playbackState?.progress ? "Resume" : "Play";
}

async function loadFeed(feedUrl: string, archiveOffset?: number) {
  const query = new URLSearchParams({ url: feedUrl });
  if (archiveOffset !== undefined) {
    query.set("view", "archive");
    query.set("offset", String(archiveOffset));
  }
  const response = await fetch(`/api/feed?${query}`);
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;

  if (!response.ok) {
    throw new Error(payload?.error || "Unable to load this feed.");
  }

  return payload as ParsedFeed;
}

async function refreshSavedFeeds(
  allFeeds: SavedFeed[],
  currentCache: FeedCache,
  feedsToRefresh: SavedFeed[],
) {
  const nextCache: FeedCache = { ...currentCache };
  const refreshedFeeds = new Map<string, SavedFeed>();
  const failedFeeds: string[] = [];

  await runWithConcurrency(
    feedsToRefresh,
    FEED_REFRESH_CONCURRENCY,
    async (feed) => {
      try {
        const parsedFeed = await loadFeed(feed.feedUrl);
        const nextSavedFeed = toSavedFeed(parsedFeed);

        refreshedFeeds.set(feed.feedUrl, nextSavedFeed);

        if (feed.feedUrl !== nextSavedFeed.feedUrl) {
          delete nextCache[feed.feedUrl];
        }

        nextCache[nextSavedFeed.feedUrl] = parsedFeed;
      } catch {
        failedFeeds.push(feed.title);
      }
    },
  );

  return {
    failedFeeds,
    nextCache,
    nextFeeds: allFeeds
      .map((feed) => refreshedFeeds.get(feed.feedUrl) ?? feed)
      .sort(sortFeedsByTitle),
  };
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        await worker(item);
      }
    }),
  );
}

function toSavedFeed(feed: ParsedFeed): SavedFeed {
  return {
    feedUrl: feed.feedUrl,
    title: feed.title,
    description: feed.description,
    link: feed.link,
    imageUrl: feed.imageUrl,
    lastFetchedAt: new Date().toISOString(),
  };
}

function sortFeedsByTitle(a: SavedFeed, b: SavedFeed) {
  return a.title.localeCompare(b.title);
}

function buildEpisodeList(feeds: SavedFeed[], cache: FeedCache, recentOnly = true) {
  const episodesByKey = new Map<string, EpisodeWithShow>();

  for (const feed of feeds) {
    const parsedFeed = cache[feed.feedUrl];

    if (!parsedFeed) {
      continue;
    }

    const episodes = recentOnly ? recentEpisodes(parsedFeed.episodes) : parsedFeed.episodes;
    for (const episode of episodes) {
      const key = getEpisodeKey(episode);

      if (!episodesByKey.has(key)) {
        episodesByKey.set(key, {
          ...episode,
          feedUrl: feed.feedUrl,
          showTitle: feed.title,
          showImageUrl: feed.imageUrl,
        });
      }
    }
  }

  return Array.from(episodesByKey.values()).sort(compareEpisodes);
}

function pruneFeedCacheToRecentEpisodes(cache: FeedCache) {
  const nextCache: FeedCache = {};
  for (const [feedUrl, feed] of Object.entries(cache)) {
    nextCache[feedUrl] = { ...feed, episodes: recentEpisodes(feed.episodes) };
  }
  return nextCache;
}

function getEpisodeKey(episode: Pick<ParsedEpisode, "guid" | "audioUrl">) {
  return episode.guid || episode.audioUrl;
}

function getEpisodeElementId(episodeKey: string) {
  let hash = 0;

  for (let index = 0; index < episodeKey.length; index += 1) {
    hash = (hash * 31 + episodeKey.charCodeAt(index)) >>> 0;
  }

  return `episode-${hash.toString(36)}`;
}

function getSortableDate(pubDate?: string) {
  return episodeTimestamp(pubDate);
}

function feedNeedsAutoRefresh(feed: SavedFeed, cache: FeedCache) {
  if (!cache[feed.feedUrl] || cache[feed.feedUrl].recentDays !== RECENT_EPISODE_DAYS) {
    return true;
  }

  if (!feed.lastFetchedAt) {
    return true;
  }

  const lastFetchedAt = new Date(feed.lastFetchedAt).getTime();

  return (
    Number.isNaN(lastFetchedAt) ||
    Date.now() - lastFetchedAt >= AUTO_REFRESH_STALE_MS
  );
}

function formatDate(pubDate?: string) {
  const time = getSortableDate(pubDate);

  if (!time) {
    return "Undated";
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(time));
}

function formatProgress(seconds: number) {
  const totalSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = (totalSeconds % 60).toString().padStart(2, "0");
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${remainder}`
    : `${minutes}:${remainder}`;
}

function parseDuration(duration?: string) {
  if (!duration || !/^\d+(?::[0-5]?\d){0,2}$/.test(duration.trim())) {
    return 0;
  }
  return duration.trim().split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

function updateMediaSession(
  episode: EpisodeWithShow,
  audio: HTMLAudioElement,
  controls: MediaSessionControls,
) {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") {
    return;
  }

  const artworkUrl = episode.imageUrl ?? episode.showImageUrl;
  const artwork = artworkUrl
    ? [
        { src: artworkUrl, sizes: "96x96" },
        { src: artworkUrl, sizes: "128x128" },
        { src: artworkUrl, sizes: "192x192" },
        { src: artworkUrl, sizes: "256x256" },
        { src: artworkUrl, sizes: "512x512" },
      ]
    : [];

  navigator.mediaSession.metadata = new MediaMetadata({
    title: episode.title,
    artist: episode.showTitle,
    album: "GoPod",
    artwork,
  });

  updateMediaSessionState(audio, audio.paused ? "paused" : "playing");
  setMediaSessionHandler("play", controls.onPlay);
  setMediaSessionHandler("pause", controls.onPause);
  // Keep system media controls consistent with the in-app 30-second buttons.
  setMediaSessionHandler("seekbackward", () => {
    audio.currentTime = Math.max(
      0,
      audio.currentTime - SKIP_SECONDS,
    );
    updateMediaSessionPosition(audio);
  });
  setMediaSessionHandler("seekforward", () => {
    const nextTime = audio.currentTime + SKIP_SECONDS;
    audio.currentTime = Number.isFinite(audio.duration)
      ? Math.min(audio.duration, nextTime)
      : nextTime;
    updateMediaSessionPosition(audio);
  });
  setMediaSessionHandler("seekto", (details) => {
    if (typeof details.seekTime !== "number") {
      return;
    }

    audio.currentTime = details.seekTime;
    updateMediaSessionPosition(audio);
  });
}

function updateMediaSessionState(
  audio: HTMLAudioElement,
  playbackState: MediaSessionPlaybackState,
) {
  if (!("mediaSession" in navigator)) {
    return;
  }

  navigator.mediaSession.playbackState = playbackState;
  updateMediaSessionPosition(audio);
}

function updateMediaSessionPosition(audio: HTMLAudioElement) {
  if (
    !("mediaSession" in navigator) ||
    !Number.isFinite(audio.duration) ||
    audio.duration <= 0
  ) {
    return;
  }

  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: audio.currentTime,
    });
  } catch {
    // Some mobile browsers expose Media Session but reject position updates.
  }
}

function clearMediaSession() {
  if (!("mediaSession" in navigator)) {
    return;
  }

  navigator.mediaSession.playbackState = "none";
  navigator.mediaSession.metadata = null;
  setMediaSessionHandler("play", null);
  setMediaSessionHandler("pause", null);
  setMediaSessionHandler("seekbackward", null);
  setMediaSessionHandler("seekforward", null);
  setMediaSessionHandler("seekto", null);
}

function setMediaSessionHandler(
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
) {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // Unsupported lock-screen actions can be ignored; native audio still works.
  }
}

function audioHasEpisodeSource(audio: HTMLAudioElement, episode: EpisodeWithShow) {
  const currentSource = audio.currentSrc || audio.src;

  if (!currentSource) {
    return false;
  }

  return normalizeMediaUrl(currentSource) === normalizeMediaUrl(episode.audioUrl);
}

function normalizeMediaUrl(url: string) {
  if (typeof window === "undefined") {
    return url;
  }

  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url;
  }
}

function getDescriptionText(description?: string) {
  return (description ?? "")
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6])>/gi, "\n\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(x[0-9a-f]+|[0-9]+);|&(amp|lt|gt|quot|apos|nbsp);/gi, (match, code: string | undefined, name: string | undefined) => {
      if (code) {
        const value = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
        return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
      }
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[name!.toLowerCase()] ?? match;
    })
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getDescriptionPreview(description?: string) {
  const plainText = getDescriptionText(description).replace(/\s+/g, " ");
  return plainText.length > 220 ? `${plainText.slice(0, 217)}...` : plainText;
}

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage<T>(key: string, value: T) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Local persistence is best-effort; playback should keep working in memory.
  }
}

function parseBackup(rawBackup: string): PodcastBackup {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBackup);
  } catch {
    throw new Error("Choose a valid GoPod backup JSON file.");
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.podcastFeeds)) {
    throw new Error("This backup file does not look like GoPod data.");
  }

  const podcastFeeds = parsed.podcastFeeds;

  if (!podcastFeeds.every(isSavedFeed)) {
    throw new Error("This backup has invalid podcast feed data.");
  }

  return {
    app: "GoPod",
    exportedAt:
      typeof parsed.exportedAt === "string"
        ? parsed.exportedAt
        : new Date().toISOString(),
    podcastEpisodesCache: pruneFeedCacheToRecentEpisodes(
      parseFeedCache(parsed.podcastEpisodesCache),
    ),
    podcastFeeds,
    podcastPlaybackState: parsePlaybackMap(parsed.podcastPlaybackState),
    version: BACKUP_VERSION,
  };
}

function parseFeedCache(value: unknown): FeedCache {
  if (!isRecord(value)) {
    return {};
  }

  const nextCache: FeedCache = {};

  for (const [feedUrl, feed] of Object.entries(value)) {
    if (isParsedFeed(feed)) {
      nextCache[feedUrl] = feed;
    }
  }

  return nextCache;
}

function parsePlaybackMap(value: unknown): PlaybackMap {
  if (!isRecord(value)) {
    return {};
  }

  const nextPlayback: PlaybackMap = {};

  for (const [episodeKey, state] of Object.entries(value)) {
    if (isPlaybackState(state)) {
      nextPlayback[episodeKey] = state;
    }
  }

  return nextPlayback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSavedFeed(value: unknown): value is SavedFeed {
  return (
    isRecord(value) &&
    typeof value.feedUrl === "string" &&
    typeof value.title === "string"
  );
}

function isParsedFeed(value: unknown): value is ParsedFeed {
  return (
    isRecord(value) &&
    typeof value.feedUrl === "string" &&
    typeof value.title === "string" &&
    Array.isArray(value.episodes)
  );
}

function isEpisodeWithShow(value: unknown): value is EpisodeWithShow {
  return isRecord(value) && typeof value.guid === "string" &&
    typeof value.audioUrl === "string" && typeof value.title === "string" &&
    typeof value.feedUrl === "string" && typeof value.showTitle === "string";
}

function isPlaybackState(value: unknown): value is EpisodePlaybackState {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (typeof value.played === "undefined" ||
      typeof value.played === "boolean") &&
    (typeof value.progress === "undefined" ||
      typeof value.progress === "number") &&
    (typeof value.duration === "undefined" ||
      typeof value.duration === "number")
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}
