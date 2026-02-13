const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { request, gql } = require('graphql-request');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Browser-like headers ─────────────────────────────────────────────────────
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
};

// ─── AniList GraphQL ──────────────────────────────────────────────────────────
const ANILIST_API = 'https://graphql.anilist.co';

const SEARCH_ANIME_BY_ID_QUERY = gql`
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id
      title {
        romaji
        english
        native
      }
      description
      coverImage {
        large
        extraLarge
      }
      bannerImage
      genres
      tags {
        name
      }
      averageScore
      popularity
      status
      episodes
      startDate {
        year
        month
        day
      }
      endDate {
        year
        month
        day
      }
      synonyms
      siteUrl
    }
  }
`;

const SEARCH_ANIME_BY_NAME_QUERY = gql`
  query ($search: String) {
    Media(search: $search, type: ANIME) {
      id
      title {
        romaji
        english
        native
      }
      description
      coverImage {
        large
        extraLarge
      }
      bannerImage
      genres
      tags {
        name
      }
      averageScore
      popularity
      status
      episodes
      startDate {
        year
        month
        day
      }
      endDate {
        year
        month
        day
      }
      synonyms
      siteUrl
    }
  }
`;

// ─── Helper: Get AniList anime data ───────────────────────────────────────────
async function getAniListAnime(idOrName) {
  try {
    const isNumeric = /^\d+$/.test(idOrName);
    
    if (isNumeric) {
      const data = await request(ANILIST_API, SEARCH_ANIME_BY_ID_QUERY, {
        id: parseInt(idOrName)
      });
      return data.Media;
    } else {
      const data = await request(ANILIST_API, SEARCH_ANIME_BY_NAME_QUERY, {
        search: idOrName
      });
      return data.Media;
    }
  } catch (err) {
    console.error('Error fetching from AniList:', err.message);
    return null;
  }
}

// ─── Helper: Search AniZone for anime by title ────────────────────────────────
async function findAniZoneIdByTitle(animeTitle, alternateTitles = []) {
  const titlesToTry = [
    animeTitle,
    ...alternateTitles,
    // Remove special characters and try again
    animeTitle.replace(/[^\w\s]/g, ''),
    // Try first word(s) only
    animeTitle.split(' ').slice(0, 2).join(' ')
  ].filter(Boolean);

  for (const title of titlesToTry) {
    try {
      const searchUrl = `https://anizone.to/anime?search=${encodeURIComponent(title)}`;
      console.log(`🔍 Searching AniZone: ${searchUrl}`);
      
      const { data: html } = await axios.get(searchUrl, {
        headers: { ...BROWSER_HEADERS, Referer: "https://anizone.to/" },
        timeout: 15_000,
      });

      // Pattern 1: Direct anime links (not episode links)
      // We want /anime/xxx but NOT /anime/xxx/1
      const pattern1 = /href="\/anime\/([a-z0-9-]+)"(?:\s|>)/gi;
      const pattern2 = /href="https?:\/\/anizone\.to\/anime\/([a-z0-9-]+)"(?:\s|>)/gi;
      
      const matches1 = [...html.matchAll(pattern1)];
      const matches2 = [...html.matchAll(pattern2)];
      const allMatches = [...matches1, ...matches2];
      
      // Filter out episode links (those followed by /number)
      const animeIds = allMatches
        .map(m => m[1])
        .filter(id => {
          // Make sure it's not followed by a number (episode link)
          const idPattern = new RegExp(`/anime/${id}/(\\d+)`, 'i');
          return !idPattern.test(html);
        });
      
      const uniqueIds = [...new Set(animeIds)];
      
      console.log(`🔍 Found ${uniqueIds.length} potential matches for "${title}":`, uniqueIds);
      
      if (uniqueIds.length > 0) {
        console.log(`✅ Using first match: ${uniqueIds[0]}`);
        return uniqueIds[0];
      }
      
    } catch (err) {
      console.error(`❌ Error searching for "${title}":`, err.message);
      continue;
    }
  }
  
  console.log(`❌ No anime found on AniZone after trying all title variations`);
  return null;
}

// ─── Subtitle probe config ────────────────────────────────────────────────────
const SUBTITLE_LANGS    = [
  "en","ja","es","es-419","pt","pt-BR","fr","de",
  "it","ar","zh","zh-Hans","zh-Hant","ko","ru","pl",
];
const SUBTITLE_INDICES  = [0,1,2,3,4,5,6,7,8,9];

function buildSubtitleCandidates(uuidBase) {
  const out = [];
  for (const idx of SUBTITLE_INDICES)
    for (const lang of SUBTITLE_LANGS)
      out.push(`${uuidBase}/subtitles/${idx}_${lang}.ass`);
  return out;
}

async function probe(url) {
  try {
    const r = await axios.head(url, {
      headers: { ...BROWSER_HEADERS, Referer: "https://anizone.to/" },
      timeout: 6_000,
      validateStatus: (s) => s < 400,
    });
    return r.status < 400 ? url : null;
  } catch { return null; }
}

async function probeSubtitles(uuidBase) {
  const candidates = buildSubtitleCandidates(uuidBase);
  const BATCH = 20;
  const found = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    const results = await Promise.all(candidates.slice(i, i + BATCH).map(probe));
    results.forEach((u) => u && found.push(u));
  }
  return found;
}

// ─── Fetch & parse master.m3u8 ───────────────────────────────────────────────
async function fetchTracksFromMaster(masterUrl) {
  try {
    const { data: text } = await axios.get(masterUrl, {
      headers: { ...BROWSER_HEADERS, Referer: "https://anizone.to/" },
      responseType: "text",
      timeout: 10_000,
    });
    const base     = masterUrl.substring(0, masterUrl.lastIndexOf("/") + 1);
    const uuidBase = masterUrl.replace(/\/master\.m3u8.*$/, "");
    const tracks   = [];
    const resolve  = (u) => (/^https?:\/\//i.test(u) ? u : base + u);

    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#")) {
        const m = line.match(/URI=["']([^"']+)/i);
        if (m) tracks.push(resolve(m[1]));
      } else if (/\.(m3u8|vtt|webvtt|ass|ssa)(\?|$)/i.test(line)) {
        tracks.push(resolve(line));
      }
    }

    tracks.push(`${uuidBase}/storyboard.vtt`);
    tracks.push(`${uuidBase}/chapters.vtt`);
    (await probeSubtitles(uuidBase)).forEach((u) => tracks.push(u));

    return [...new Set(tracks)];
  } catch { return []; }
}

// ─── Classify URL ─────────────────────────────────────────────────────────────
function classifyUrl(url) {
  if (/\/audio\//i.test(url)) {
    const m = url.match(/\/audio\/(?:\d+_)?([^/]+)\//i);
    return { type: "audio", label: `audio_${m ? m[1] : "unknown"}` };
  }
  if (/\/video\//i.test(url)) {
    const m = url.match(/\/video\/(\d+)\//i);
    return { type: "video", label: `video_${m ? m[1] + "p" : "unknown"}` };
  }
  if (/\/subtitles?\//i.test(url) && /\.(ass|ssa|vtt|webvtt)$/i.test(url)) {
    const m = url.match(/\/subtitles?\/(?:\d+_)?([^/.]+)\./i);
    return { type: "subtitle", label: `subtitle_${m ? m[1] : "unknown"}` };
  }
  if (/\/subtitles?\//i.test(url) || /\/sub\//i.test(url)) {
    const m = url.match(/\/(?:subtitles?|sub)\/([^/]+)\//i);
    return { type: "subtitle", label: `subtitle_${m ? m[1] : "unknown"}` };
  }
  if (/storyboard\.vtt/i.test(url)) return { type: "storyboard", label: "storyboard" };
  if (/chapters\.vtt/i.test(url))   return { type: "chapters",   label: "chapters"   };
  if (/\.(vtt|webvtt)$/i.test(url)) return { type: "subtitle",   label: "subtitle"   };
  if (/master\.m3u8/i.test(url))    return { type: "master",     label: "master"     };
  return { type: "other", label: "other" };
}

// ─── Build stream response ────────────────────────────────────────────────────
function buildResponse(urls) {
  const master = [], video = [], audio = [], subtitle = [],
        storyboard = [], chapters = [], other = [];

  for (const url of urls) {
    const { type, label } = classifyUrl(url);
    const entry = { urls: [url] };
    if      (type === "master")     master.push(entry);
    else if (type === "video")      { entry.resolution = label; video.push(entry); }
    else if (type === "audio")      { entry.language   = label; audio.push(entry); }
    else if (type === "subtitle")   { entry.language   = label; subtitle.push(entry); }
    else if (type === "storyboard") storyboard.push(entry);
    else if (type === "chapters")   chapters.push(entry);
    else                            other.push(entry);
  }
  video.sort((a, b) => parseInt(b.resolution) - parseInt(a.resolution));
  return { success: true, master, video, audio, subtitle, storyboard, chapters,
           ...(other.length ? { other } : {}) };
}

// ─── Tiny HTML text extractor (no cheerio needed) ────────────────────────────
function stripTags(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function attr(html, tag, attribute) {
  const re = new RegExp(`<${tag}[^>]+${attribute}=["']([^"']+)["']`, "i");
  const m  = html.match(re);
  return m ? m[1] : null;
}
function between(html, open, close) {
  const start = html.indexOf(open);
  if (start === -1) return null;
  const end = html.indexOf(close, start + open.length);
  return end === -1 ? null : html.slice(start + open.length, end);
}

// ─── GET /latest ──────────────────────────────────────────────────────────────
app.get("/latest", async (req, res) => {
  try {
    console.log(`📡 Fetching latest episodes from AniZone homepage...`);
    
    const { data: html } = await axios.get("https://anizone.to/", {
      headers: { ...BROWSER_HEADERS, Referer: "https://anizone.to/" },
      timeout: 15_000,
    });

    const latestEpisodes = [];
    
    // Match each <li> block containing episode information
    const episodeBlocks = [...html.matchAll(/<li[^>]*x-data[^>]*>([\s\S]*?)<\/li>/gi)];
    
    console.log(`📺 Found ${episodeBlocks.length} episode blocks`);

    for (const block of episodeBlocks) {
      const liHtml = block[0];
      
      // Extract episode URL and episode number
      const episodeUrlMatch = liHtml.match(/href=["'](https:\/\/anizone\.to\/anime\/([^"'\/]+)\/(\d+))["']/i);
      if (!episodeUrlMatch) continue;
      
      const episodeUrl = episodeUrlMatch[1];
      const animeId = episodeUrlMatch[2];
      const episodeNumber = parseInt(episodeUrlMatch[3]);
      
      // Extract anime URL and title
      const animeLinkMatch = liHtml.match(/href=["'](https:\/\/anizone\.to\/anime\/[^"'\/]+)["'][^>]*title=["']([^"']+)["']/i);
      const animeUrl = animeLinkMatch ? animeLinkMatch[1] : null;
      const animeTitle = animeLinkMatch ? animeLinkMatch[2] : null;
      
      // Extract episode title
      const episodeTitleMatch = liHtml.match(/title=["']Episode \d+[^"']*:([^"']+)["']/i) 
                             || liHtml.match(/>Episode \d+\s*:\s*([^<]+)</i);
      const episodeTitle = episodeTitleMatch ? episodeTitleMatch[1].trim() : null;
      
      // Extract snapshot and teaser images
      const snapshotMatch = liHtml.match(/src=["'](https:\/\/[^"']+\/snapshot\.webp)["']/i);
      const teaserMatch = liHtml.match(/:src=["'][^"']*\?\s*["'](https:\/\/[^"']+\/teaser\.webp)["']/i)
                       || liHtml.match(/["'](https:\/\/[^"']+\/teaser\.webp)["']/i);
      
      const snapshot = snapshotMatch ? snapshotMatch[1] : null;
      const teaser = teaserMatch ? teaserMatch[1] : null;
      
      // Extract duration
      const durationMatch = liHtml.match(/>(\d+:\d+)<\//i);
      const duration = durationMatch ? durationMatch[1] : null;
      
      // Extract release date
      const dateMatch = liHtml.match(/(\d{4}-\d{2}-\d{2})/i);
      const releaseDate = dateMatch ? dateMatch[1] : null;
      
      // Extract "Today", "Yesterday", etc. label
      const timeLabelMatch = liHtml.match(/title=["']([^"']+)["'][^>]*>[^<]*<svg[^>]*>[^<]*<\/svg>\s*(\d{4}-\d{2}-\d{2})/i);
      const timeLabel = timeLabelMatch ? timeLabelMatch[1] : null;
      
      latestEpisodes.push({
        anime: {
          id: animeId,
          title: animeTitle,
          url: animeUrl,
        },
        episode: {
          number: episodeNumber,
          title: episodeTitle,
          url: episodeUrl,
          episodeId: `${animeId}/${episodeNumber}`,
        },
        images: {
          snapshot,
          teaser,
        },
        duration,
        release_date: releaseDate,
        time_label: timeLabel,
      });
    }

    console.log(`✅ Extracted ${latestEpisodes.length} latest episodes`);

    return res.json({
      success: true,
      count: latestEpisodes.length,
      episodes: latestEpisodes,
    });

  } catch (err) {
    console.error('❌ Error:', err.message);
    return res.status(500).json({ 
      error: "Failed to fetch latest episodes", 
      detail: err.message 
    });
  }
});

// ─── GET /details/:animeId  ───────────────────────────────────────────────────
// Accepts both AniList ID (numeric) or AniZone ID (alphanumeric)
// e.g. GET /details/21 or GET /details/uyyyn4kf
app.get("/details/:animeId", async (req, res) => {
  let { animeId } = req.params;
  const isAniListId = /^\d+$/.test(animeId);
  
  let aniListData = null;
  let aniZoneId = animeId;

  try {
    // If numeric ID, fetch from AniList and find matching AniZone ID
    if (isAniListId) {
      console.log(`🔍 Fetching AniList data for ID: ${animeId}`);
      aniListData = await getAniListAnime(animeId);
      
      if (!aniListData) {
        return res.status(404).json({ 
          error: "Anime not found on AniList",
          anilist_id: animeId 
        });
      }

      console.log(`✅ Found on AniList: ${aniListData.title.english || aniListData.title.romaji}`);

      // Collect all possible title variations
      const alternateTitles = [
        aniListData.title.english,
        aniListData.title.romaji,
        aniListData.title.native,
        ...(aniListData.synonyms || [])
      ].filter(Boolean);

      // Try to find the anime on AniZone using the title
      const searchTitle = aniListData.title.english || aniListData.title.romaji;
      console.log(`🔍 Searching AniZone for: ${searchTitle}`);
      console.log(`📝 Alternate titles:`, alternateTitles);
      
      aniZoneId = await findAniZoneIdByTitle(searchTitle, alternateTitles);

      if (!aniZoneId) {
        console.log(`⚠️  Not found on AniZone`);
        // Return AniList data even if not found on AniZone
        return res.json({
          success: true,
          source: "anilist_only",
          anilist_id: aniListData.id,
          anizone_id: null,
          title: aniListData.title.english || aniListData.title.romaji,
          title_romaji: aniListData.title.romaji,
          title_english: aniListData.title.english,
          title_native: aniListData.title.native,
          poster: aniListData.coverImage.extraLarge || aniListData.coverImage.large,
          banner: aniListData.bannerImage,
          synopsis: aniListData.description ? stripTags(aniListData.description) : null,
          genres: aniListData.genres,
          tags: aniListData.tags.map(t => t.name),
          status: aniListData.status,
          episodes: [],
          episode_count: aniListData.episodes,
          year: aniListData.startDate?.year,
          average_score: aniListData.averageScore,
          popularity: aniListData.popularity,
          anilist_url: aniListData.siteUrl,
          message: "Anime found on AniList but not available on AniZone"
        });
      }

      console.log(`✅ Found on AniZone with ID: ${aniZoneId}`);
    }

    // Now fetch from AniZone using the aniZoneId
    const pageUrl = `https://anizone.to/anime/${aniZoneId}`;
    console.log(`📡 Fetching AniZone page: ${pageUrl}`);

    const { data: html } = await axios.get(pageUrl, {
      headers: { ...BROWSER_HEADERS, Referer: "https://anizone.to/" },
      timeout: 15_000,
    });

    // ── Poster image ──────────────────────────────────────────────────────────
    const imgMatch = html.match(/<img[^>]+src=["'](https:\/\/anizone\.to\/images\/anime\/[^"']+)["'][^>]+alt=["']([^"']*)["'][^>]*>/i)
                  || html.match(/<img[^>]+alt=["']([^"']*)["'][^>]+src=["'](https:\/\/anizone\.to\/images\/anime\/[^"']+)["'][^>]*>/i);

    let poster    = null;
    let posterAlt = null;
    if (imgMatch) {
      const fullTag  = imgMatch[0];
      const srcFirst = fullTag.indexOf("src=") < fullTag.indexOf("alt=");
      poster    = srcFirst ? imgMatch[1] : imgMatch[2];
      posterAlt = srcFirst ? imgMatch[2] : imgMatch[1];
    }

    // ── Banner ────────────────────────────────────────────────────────────────
    const bannerMatch = html.match(/<img[^>]+src=["'](https:\/\/anizone\.to\/images\/anime\/[^"']+)["'][^>]+class=["'][^"']*object-cover[^"']*["'][^>]*>/i)
                     || html.match(/<img[^>]+class=["'][^"']*object-cover[^"']*["'][^>]+src=["'](https:\/\/anizone\.to\/images\/anime\/[^"']+)["'][^>]*>/i);

    let banner = null;
    if (bannerMatch) {
      const bt       = bannerMatch[0];
      const srcFirst = bt.indexOf("src=") < bt.indexOf("class=");
      banner = srcFirst ? bannerMatch[1] : bannerMatch[bannerMatch.length - 1];
    }

    // ── Title ─────────────────────────────────────────────────────────────────
    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const title = titleMatch ? stripTags(titleMatch[1]) : null;

    // ── Synopsis ─────────────────────────────────────────────────────────────
    const synopsisBlock = between(html, '<h3 class="sr-only">Synopsis</h3>', '</div>');
    const synopsis = synopsisBlock ? stripTags(synopsisBlock) : null;

    // ── Metadata spans (Type, Status, Episodes, Year) ─────────────────────────
    const spanMatches = [...html.matchAll(/<span[^>]*class="[^"]*flex[^"]*items-center[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)];
    const metaTexts   = spanMatches.map((m) => stripTags(m[1])).filter(Boolean);

    const typeVal     = metaTexts.find((t) => /TV Series|Movie|OVA|ONA|Special/i.test(t))?.match(/TV Series|Movie|OVA|ONA|Special/i)?.[0] ?? null;
    const statusVal   = metaTexts.find((t) => /Ongoing|Completed|Upcoming/i.test(t))?.match(/Ongoing|Completed|Upcoming/i)?.[0] ?? null;
    const episodesVal = metaTexts.find((t) => /\d+\s*Episodes?/i.test(t))?.match(/(\d+)/)?.[1] ?? null;
    const yearVal     = metaTexts.find((t) => /^\d{4}$/.test(t.trim()))?.trim() ?? null;

    // ── Tags ──────────────────────────────────────────────────────────────────
    const tagMatches = [...html.matchAll(/href="[^"]+\/tag\/[^""]+"[^>]*title="([^"]+)"/gi)];
    const tags = [...new Set(tagMatches.map((m) => m[1]))];

    // ── Official site ─────────────────────────────────────────────────────────
    const officialMatch = html.match(/href="([^"]+)"[^>]*title="[^"]*"[^>]*[^>]*>Official Site<\/a>/i)
                       || html.match(/rel="nofollow noopener noreferrer"[^>]*href="([^"]+)"/i);
    const officialSite = officialMatch ? officialMatch[1] : null;

    // ── Start watching link ───────────────────────────────────────────────────
    const watchMatch = html.match(/href="(https?:\/\/anizone\.to\/anime\/[^"]+\/\d+)"/i);
    const startWatching = watchMatch ? watchMatch[1] : null;

    // ── Episode list ──────────────────────────────────────────────────────────
    console.log(`📺 Extracting episodes...`);

    // First, get episode count from metadata
    const epCountMatch = html.match(/(\d+)\s*Episodes?/i);
    const totalEpisodes = epCountMatch ? parseInt(epCountMatch[1]) : (aniListData?.episodes || null);

    console.log(`📊 Total episodes: ${totalEpisodes}`);

    // Extract visible episodes from the page
    const episodeBlocks = [...html.matchAll(
      /<a[^>]+href="(https?:\/\/anizone\.to\/anime\/[^"]+\/(\d+))"[^>]*>[\s\S]*?<\/a>/gi
    )];

    console.log(`📺 Found ${episodeBlocks.length} episode blocks in HTML`);

    const episodes = [];
    const seenEps  = new Set();
    const episodeDetails = new Map(); // Store detailed info for episodes we found

    for (const block of episodeBlocks) {
      const epUrl  = block[1];
      const epNum  = parseInt(block[2]);
      if (seenEps.has(epNum)) continue;
      seenEps.add(epNum);

      const epHtml = block[0];

      const teaserMatch   = epHtml.match(/['"]?(https?:\/\/[^"'\s]+\/teaser\.webp)['"]?/i);
      const snapshotMatch = epHtml.match(/['"]?(https?:\/\/[^"'\s]+\/snapshot\.webp)['"]?/i);

      const h3Match = epHtml.match(/<h3[^>]*>([^<]+)<\/h3>/i);
      const epTitle = h3Match ? h3Match[1].trim() : null;

      const descMatch = epHtml.match(/<span[^>]*text-slate-100[^>]*text-sm[^>]*>([^<]+)<\/span>/i)
                     || epHtml.match(/<span[^>]*text-sm[^>]*text-slate-100[^>]*>([^<]+)<\/span>/i);
      const description = descMatch ? descMatch[1].trim() : null;

      const typeMatch = epHtml.match(/Regular Episode|Special|OVA|Recap|Filler/i);
      const epType    = typeMatch ? typeMatch[0] : null;

      const dateMatch = epHtml.match(/(\d{4}-\d{2}-\d{2})/);
      const airDate   = dateMatch ? dateMatch[1] : null;

      const altMatch = epHtml.match(/alt="([^"]+)"/i);
      const altText  = altMatch ? altMatch[1] : null;

      const episodeIdMatch = epUrl.match(/\/anime\/([^\/]+\/\d+)/);
      const episodeId = episodeIdMatch ? episodeIdMatch[1] : null;

      // Store detailed info
      episodeDetails.set(epNum, {
        episode:     epNum,
        episodeId:   episodeId,
        url:         epUrl,
        title:       epTitle,
        alt:         altText,
        description,
        type:        epType,
        air_date:    airDate,
        teaser:      teaserMatch   ? teaserMatch[1]   : null,
        snapshot:    snapshotMatch ? snapshotMatch[1] : null,
      });
    }

    // Now generate all episodes (1 to totalEpisodes)
    if (totalEpisodes) {
      for (let i = 1; i <= totalEpisodes; i++) {
        if (episodeDetails.has(i)) {
          // Use detailed info if we have it
          episodes.push(episodeDetails.get(i));
        } else {
          // Generate basic episode entry
          episodes.push({
            episode:     i,
            episodeId:   `${aniZoneId}/${i}`,
            url:         `https://anizone.to/anime/${aniZoneId}/${i}`,
            title:       `Episode ${i}`,
            alt:         null,
            description: null,
            type:        "Regular Episode",
            air_date:    null,
            teaser:      null,
            snapshot:    null,
          });
        }
      }
    } else {
      // If we don't have total count, just use what we found
      episodeDetails.forEach(ep => episodes.push(ep));
    }

    episodes.sort((a, b) => a.episode - b.episode);
    console.log(`✅ Generated ${episodes.length} episodes (${episodeDetails.size} with details, ${episodes.length - episodeDetails.size} generated)`);

    const response = {
      success:       true,
      source:        isAniListId ? "anilist_anizone" : "anizone",
      id:            aniZoneId,
      url:           pageUrl,
      title:         title || (aniListData?.title.english || aniListData?.title.romaji),
      poster:        poster || (aniListData?.coverImage?.extraLarge),
      poster_alt:    posterAlt,
      banner:        banner || aniListData?.bannerImage,
      type:          typeVal,
      status:        statusVal,
      episode_count: episodesVal ? parseInt(episodesVal) : (aniListData?.episodes || null),
      year:          yearVal ? parseInt(yearVal) : (aniListData?.startDate?.year || null),
      synopsis:      synopsis || (aniListData?.description ? stripTags(aniListData.description) : null),
      tags,
      official_site: officialSite,
      start_watching: startWatching,
      episodes,
    };

    // Add AniList data if available
    if (aniListData) {
      response.anilist_id = aniListData.id;
      response.anilist_url = aniListData.siteUrl;
      response.title_romaji = aniListData.title.romaji;
      response.title_english = aniListData.title.english;
      response.title_native = aniListData.title.native;
      response.genres = aniListData.genres;
      response.average_score = aniListData.averageScore;
      response.popularity = aniListData.popularity;
    }

    return res.json(response);

  } catch (err) {
    console.error('❌ Error:', err.message);
    return res.status(500).json({ 
      error: "Failed to fetch anime details", 
      detail: err.message,
      anilist_id: isAniListId ? animeId : null,
      anizone_id: !isAniListId ? animeId : aniZoneId
    });
  }
});

// ─── GET /scrape?url=<episode_page> ──────────────────────────────────────────
app.get("/scrape", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url= query parameter" });

  try {
    const { data: html } = await axios.get(url, {
      headers: { ...BROWSER_HEADERS, Referer: "https://anizone.to/" },
      timeout: 15_000,
    });

    const mediaRegex = /https?:\/\/[^"'\s]+\.(m3u8|vtt|webvtt|ass|ssa)[^"'\s]*/gi;
    let found = html.match(mediaRegex) || [];
    const kvRegex = /(?:file|src|source|url)\s*[=:]\s*["']([^"']+\.(?:m3u8|vtt|ass)[^"']*)/gi;
    let m;
    while ((m = kvRegex.exec(html)) !== null) found.push(m[1]);
    found = [...new Set(found)];

    if (found.length === 0)
      return res.status(404).json({ success: false, error: "No media URLs found in page HTML." });

    const masters     = found.filter((u) => /master\.m3u8/i.test(u));
    const seeds       = masters.length > 0 ? masters : found;
    const trackArrays = await Promise.all(seeds.map(fetchTracksFromMaster));
    const allUrls     = [...new Set([...seeds, ...trackArrays.flat()])];

    return res.json(buildResponse(allUrls));
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch the page", detail: err.message });
  }
});

// ─── GET /streams ─────────────────────────────────────────────────────────────
const DEFAULT_MASTER =
  "https://seiryuu.vid-cdn.xyz/a83ec4ac-474b-4308-9d35-a5a2d6894868/master.m3u8";

app.get("/streams", async (_req, res) => {
  const tracks = await fetchTracksFromMaster(DEFAULT_MASTER);
  res.json(buildResponse([...new Set([DEFAULT_MASTER, ...tracks])]));
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) =>
  res.json({
    status: "ok",
    routes: {
      "GET /":                          "API health check and available routes",
      "GET /latest":                    "Get latest episodes from AniZone homepage",
      "GET /details/:animeId":          "Get anime details (accepts AniList ID or AniZone ID)",
      "GET /scrape?url=<episode_page>": "Scrape episode streams → master/video/audio/subtitle/storyboard/chapters",
      "GET /streams":                   "Return default episode streams live from CDN",
    },
  })
);

app.listen(PORT, () =>
  console.log(`✅  AniZone stream server running → http://localhost:${PORT}`)
);