const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Debug endpoint
app.get('/api/debug/:mangaId/:chapterId', async (req, res) => {
  try {
    const { mangaId, chapterId } = req.params;
    const url = `https://mangabuddy.com/${mangaId}/${chapterId}`;

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    
    // Get all img tags
    const allImages = [];
    $('img').each((i, elem) => {
      allImages.push({
        src: $(elem).attr('src'),
        'data-src': $(elem).attr('data-src'),
        'data-lazy': $(elem).attr('data-lazy'),
        'data-original': $(elem).attr('data-original'),
        alt: $(elem).attr('alt'),
        class: $(elem).attr('class'),
        id: $(elem).attr('id')
      });
    });

    // Get all scripts containing image data
    const scripts = [];
    $('script').each((i, elem) => {
      const content = $(elem).html();
      if (content && (content.includes('image') || content.includes('page') || content.includes('chapter'))) {
        scripts.push(content.substring(0, 500));
      }
    });

    // Get all scripts content for debugging
    const allScripts = [];
    $('script').each((i, elem) => {
      const content = $(elem).html();
      if (content && (content.includes('image') || content.includes('mbcdns') || content.includes('chapter'))) {
        allScripts.push({
          index: i,
          snippet: content.substring(0, 1000),
          length: content.length
        });
      }
    });

    res.json({
      url: url,
      totalImages: allImages.length,
      images: allImages,
      scriptSnippets: scripts,
      scriptsWithImageData: allScripts,
      bodySnippet: $('body').html().substring(0, 2000)
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Main scraper - with path parameters
app.get('/api/scrape/chapter/:mangaId/:chapterId', async (req, res) => {
  try {
    const { mangaId, chapterId } = req.params;
    const url = `https://mangabuddy.com/${mangaId}/${chapterId}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://mangabuddy.com/'
      }
    });

    const $ = cheerio.load(response.data);
    const chapterTitle = $('h1').first().text().trim() || 'Chapter';

    // Extract images
    const imageUrls = new Set();
    
    // Method 1: Get visible images first
    $('img').each((i, elem) => {
      const $elem = $(elem);
      const src = $elem.attr('src') || $elem.attr('data-src') || $elem.attr('data-original');
      if (src && src.includes('mbcdns')) {
        imageUrls.add(src);
      }
    });

    // Method 2: Extract ALL mbcdns URLs from all script tags
    $('script').each((i, elem) => {
      const scriptText = $(elem).html() || '';
      if (!scriptText) return;
      
      // Find all URLs that match the pattern
      const regex = /https?:\/\/s\d+\.mbcdns[a-z]+\.org\/[^\s"',]+\.(?:jpg|jpeg|png|webp)/gi;
      const matches = scriptText.match(regex);
      
      if (matches) {
        matches.forEach(url => {
          let cleanUrl = url.replace(/[\\",;)\]]+$/, '');
          imageUrls.add(cleanUrl);
        });
      }
    });

    // Convert Set to Array and create page objects
    const pages = Array.from(imageUrls).map((url, index) => ({
      page: index + 1,
      imageUrl: url,
      alt: `Page ${index + 1}`
    }));

    // Sort by CDN subdomain number (s1, s2, s3, etc)
    pages.sort((a, b) => {
      const aMatch = a.imageUrl.match(/s(\d+)\./);
      const bMatch = b.imageUrl.match(/s(\d+)\./);
      const aNum = aMatch ? parseInt(aMatch[1]) : 0;
      const bNum = bMatch ? parseInt(bMatch[1]) : 0;
      return aNum - bNum;
    });

    // Renumber after sorting
    pages.forEach((page, index) => {
      page.page = index + 1;
      page.alt = `Page ${index + 1}`;
    });

    res.json({
      success: true,
      data: {
        title: chapterTitle,
        url: url,
        mangaId: mangaId,
        chapterId: chapterId,
        totalPages: pages.length,
        pages: pages.map(p => ({
          ...p,
          proxiedUrl: `http://localhost:${PORT}/api/image-proxy?url=${encodeURIComponent(p.imageUrl)}`
        })),
        note: pages.length === 0 ? 'No images found.' : 'All images found!'
      }
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});



// Scrape manga details and chapter list
app.get('/api/scrape/manga/:mangaId', async (req, res) => {
  try {
    const { mangaId } = req.params;
    const url = `https://mangabuddy.com/${mangaId}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    const $ = cheerio.load(response.data);
    
    // Extract manga info
    const title = $('h1').first().text().trim() || $('.manga-title').text().trim();
    const description = $('.summary').text().trim() || $('.description').text().trim();
    const cover = $('img.manga-cover').attr('src') || $('.manga-image img').attr('src');
    
    // Extract chapters
    const chapters = [];
    $('#chapter-list li, .chapter-list li').each((i, elem) => {
      const $elem = $(elem);
      const $link = $elem.find('a');
      const href = $link.attr('href');
      const chapterTitle = $link.find('.chapter-title, strong').text().trim();
      const date = $link.find('.chapter-update, time').text().trim();
      
      if (href && chapterTitle) {
        // Extract chapterId from URL
        let chapterId = '';
        try {
          const urlObj = new URL(href.startsWith('http') ? href : `https://mangabuddy.com${href}`);
          chapterId = urlObj.pathname.substring(1);
        } catch (e) {
          chapterId = href.replace(/^\//, '').replace(/^https?:\/\/mangabuddy\.com\//, '');
        }
        
        chapters.push({
          title: chapterTitle,
          url: href.startsWith('http') ? href : `https://mangabuddy.com${href}`,
          date: date || null,
          chapterId: chapterId
        });
      }
    });

    res.json({
      success: true,
      data: {
        title: title,
        description: description,
        cover: cover,
        mangaId: mangaId,
        totalChapters: chapters.length,
        chapters: chapters
      }
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Image proxy endpoint - bypasses CORS
app.get('/api/image-proxy', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter required' });
    }

    // Validate it's a manga image URL
    if (!url.includes('mbcdns')) {
      return res.status(403).json({ error: 'Only MangaBuddy images allowed' });
    }

    console.log(`Proxying image: ${url}`);

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://mangabuddy.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      },
      timeout: 30000
    });

    // Get content type from response
    const contentType = response.headers['content-type'] || 'image/jpeg';
    
    // Set appropriate headers
    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });

    // Send the image
    res.send(Buffer.from(response.data));

  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch image',
      message: error.message 
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.json({
    message: 'Manga Scraper API with Image Proxy - Path Parameters',
    endpoints: {
      debug: '/api/debug/:mangaId/:chapterId',
      scrapeChapter: '/api/scrape/chapter/:mangaId/:chapterId',
      scrapeManga: '/api/scrape/manga/:mangaId',
      imageProxy: '/api/image-proxy?url=IMAGE_URL'
    },
    examples: {
      debug: '/api/debug/clevatess-the-king-of-devil-beasts-the-baby-and-the-brave-of-the-undead/chapter-58',
      scrapeChapter: '/api/scrape/chapter/clevatess-the-king-of-devil-beasts-the-baby-and-the-brave-of-the-undead/chapter-58',
      scrapeManga: '/api/scrape/manga/jujutsu-kaisen'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📖 Example: http://localhost:${PORT}/api/scrape/chapter/jujutsu-kaisen/chapter-266`);
  console.log(`📖 Example: http://localhost:${PORT}/api/scrape/manga/jujutsu-kaisen`);
});