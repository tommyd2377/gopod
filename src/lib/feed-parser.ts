import { XMLParser } from "fast-xml-parser";
import type { ParsedEpisode, ParsedFeed } from "@/lib/types";

type XmlRecord = Record<string, unknown>;

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedParseError";
  }
}

const parser = new XMLParser({
  attributeNamePrefix: "",
  cdataPropName: "__cdata",
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  removeNSPrefix: false,
  textNodeName: "#text",
  trimValues: true,
});

export function parsePodcastFeed(xml: string, feedUrl: string): ParsedFeed {
  let parsed: unknown;

  try {
    parsed = parser.parse(xml);
  } catch {
    throw new FeedParseError("Invalid RSS/XML feed.");
  }

  const root = asRecord(parsed);

  if (!root) {
    throw new FeedParseError("Invalid RSS/XML feed.");
  }

  const rss = asRecord(root.rss) ?? asRecord(root["rdf:RDF"]);
  const channel = asRecord(rss?.channel);

  if (!channel) {
    throw new FeedParseError("Invalid RSS feed: no channel was found.");
  }

  const feedImageUrl = extractFeedImage(channel);
  const title = textValue(channel.title) || "Untitled podcast";
  const items = toArray(channel.item).flatMap((item) => {
    const episode = parseEpisode(asRecord(item), feedImageUrl);
    return episode ? [episode] : [];
  });

  if (items.length === 0) {
    throw new FeedParseError("No playable audio enclosures were found.");
  }

  return {
    feedUrl,
    title,
    description: optionalText(channel.description),
    link: optionalText(channel.link),
    imageUrl: feedImageUrl,
    episodes: items,
  };
}

function parseEpisode(
  item: XmlRecord | undefined,
  feedImageUrl?: string,
): ParsedEpisode | null {
  if (!item) {
    return null;
  }

  const enclosure = findPlayableEnclosure(item.enclosure);
  const audioUrl = enclosure?.url;

  if (!audioUrl) {
    return null;
  }

  const guid = textValue(item.guid) || audioUrl;
  const description =
    optionalText(item.description) ?? optionalText(item["content:encoded"]);

  return {
    guid,
    title: textValue(item.title) || "Untitled episode",
    description,
    pubDate: optionalText(item.pubDate),
    duration: optionalText(item["itunes:duration"]),
    audioUrl,
    audioType: enclosure.type,
    imageUrl: extractItunesImage(item) ?? feedImageUrl,
    episodeUrl: optionalText(item.link),
  };
}

function findPlayableEnclosure(value: unknown) {
  return toArray(value)
    .map((enclosure) => asRecord(enclosure))
    .find((enclosure) => {
      const url = optionalText(enclosure?.url);
      const type = optionalText(enclosure?.type);

      if (!url) {
        return false;
      }

      return !type || type.toLowerCase().startsWith("audio/");
    }) as { url?: string; type?: string } | undefined;
}

function extractFeedImage(channel: XmlRecord) {
  const channelImageUrl = optionalText(asRecord(channel.image)?.url);
  return extractItunesImage(channel) ?? channelImageUrl;
}

function extractItunesImage(record: XmlRecord) {
  const image = firstRecord(record["itunes:image"]);
  return optionalText(image?.href) ?? optionalText(image?.url);
}

function firstRecord(value: unknown) {
  const first = Array.isArray(value) ? value[0] : value;
  return asRecord(first);
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): XmlRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as XmlRecord;
}

function optionalText(value: unknown) {
  const text = textValue(value);
  return text.length > 0 ? text : undefined;
}

function textValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }

  if (Array.isArray(value)) {
    return textValue(value[0]);
  }

  const record = asRecord(value);

  if (!record) {
    return "";
  }

  return (
    textValue(record["#text"]) ||
    textValue(record.__cdata) ||
    textValue(record.value)
  );
}
