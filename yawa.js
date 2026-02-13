const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.options('*', cors());

const getHeaders = (referer = 'https://kwik.cx/') => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin': referer.replace(/\/$/, ''),
  'Referer': referer,
  'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site'
});

function isMediaPlaylist(content) {
  return content.includes('#EXTINF') || content.includes('#EXT-X-TARGETDURATION');
}

function isMasterPlaylist(content) {
  return content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-I-FRAME-STREAM-INF');
}

// Analyze playlist and get codec information
app.get('/api/analyze', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });

    const decodedUrl = decodeURIComponent(url);
    const response = await axios.get(decodedUrl, {
      headers: getHeaders(),
      responseType: 'text',
      timeout: 30000
    });

    const content = response.data;
    const analysis = {
      url: decodedUrl,
      isMaster: isMasterPlaylist(content),
      isMedia: isMediaPlaylist(content),
      hasEncryption: content.includes('#EXT-X-KEY'),
      encryptionMethod: null,
      codecs: [],
      variants: [],
      segments: []
    };

    // Extract encryption info
    const keyMatch = content.match(/#EXT-X-KEY:METHOD=([^,]+)/);
    if (keyMatch) {
      analysis.encryptionMethod = keyMatch[1];
    }

    // Extract codecs from master playlist
    const codecMatches = content.matchAll(/#EXT-X-STREAM-INF:[^\n]*CODECS="([^"]+)"/g);
    for (const match of codecMatches) {
      analysis.codecs.push(match[1]);
    }

    // Extract variant playlists
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('#EXT-X-STREAM-INF')) {
        const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/);
        const resolutionMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
        const codecsMatch = lines[i].match(/CODECS="([^"]+)"/);
        
        if (lines[i + 1] && !lines[i + 1].startsWith('#')) {
          analysis.variants.push({
            url: lines[i + 1].trim(),
            bandwidth: bandwidthMatch ? bandwidthMatch[1] : null,
            resolution: resolutionMatch ? resolutionMatch[1] : null,
            codecs: codecsMatch ? codecsMatch[1] : null
          });
        }
      }
    }

    // If media playlist, get first few segments
    if (analysis.isMedia) {
      const segmentMatches = content.matchAll(/#EXTINF:([\d.]+),[^\n]*\n([^\n#]+)/g);
      let count = 0;
      for (const match of segmentMatches) {
        if (count++ < 3) {
          analysis.segments.push({
            duration: parseFloat(match[1]),
            url: match[2].trim()
          });
        }
      }
    }

    res.json(analysis);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/proxy/playlist.m3u8', async (req, res) => {
  try {
    const { url, referer, absolute } = req.query;
    
    if (!url) {
      return res.status(400).send('URL parameter is required');
    }

    const decodedUrl = decodeURIComponent(url);
    const finalReferer = referer || 'https://kwik.cx/';
    const useAbsolute = absolute === 'true';
    
    console.log(`[Playlist] Fetching: ${decodedUrl}`);
    
    const response = await axios.get(decodedUrl, {
      headers: getHeaders(finalReferer),
      responseType: 'text',
      timeout: 30000
    });

    let content = response.data;
    const baseUrl = decodedUrl.substring(0, decodedUrl.lastIndexOf('/') + 1);

    const isMaster = isMasterPlaylist(content);
    const isMedia = isMediaPlaylist(content);
    
    console.log(`[Playlist] Type: ${isMaster ? 'MASTER' : isMedia ? 'MEDIA' : 'UNKNOWN'}`);

    const getProxyBase = () => {
      if (useAbsolute) {
        const protocol = req.protocol;
        const host = req.get('host');
        return `${protocol}://${host}`;
      }
      return '';
    };

    const proxyBase = getProxyBase();
    const lines = content.split('\n');
    const processedLines = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.includes('#EXT-X-KEY')) {
        const uriMatch = line.match(/URI="([^"]+)"/);
        if (uriMatch) {
          let keyUrl = uriMatch[1];
          console.log(`[Playlist] Original key URL: ${keyUrl}`);
          
          if (!keyUrl.startsWith('http')) {
            keyUrl = baseUrl + keyUrl;
          }
          
          console.log(`[Playlist] Resolved key URL: ${keyUrl}`);
          
          const encodedKeyUrl = encodeURIComponent(keyUrl);
          const proxyKeyUrl = `${proxyBase}/proxy/key?url=${encodedKeyUrl}&referer=${encodeURIComponent(finalReferer)}`;
          
          const newLine = line.replace(/URI="[^"]+"/, `URI="${proxyKeyUrl}"`);
          console.log(`[Playlist] ✅ Proxied encryption key`);
          processedLines.push(newLine);
          continue;
        }
      }

      if (line.includes('#EXT-X-MAP')) {
        const uriMatch = line.match(/URI="([^"]+)"/);
        if (uriMatch) {
          let mapUrl = uriMatch[1];
          if (!mapUrl.startsWith('http')) {
            mapUrl = baseUrl + mapUrl;
          }
          const proxyMapUrl = `${proxyBase}/proxy/segment?url=${encodeURIComponent(mapUrl)}&referer=${encodeURIComponent(finalReferer)}`;
          const newLine = line.replace(/URI="[^"]+"/, `URI="${proxyMapUrl}"`);
          processedLines.push(newLine);
          continue;
        }
      }

      if (line.startsWith('#')) {
        processedLines.push(line);
        continue;
      }

      if (line.trim() === '') {
        processedLines.push(line);
        continue;
      }

      let targetUrl = line.trim();
      
      if (targetUrl.startsWith('/proxy/') || targetUrl.includes('localhost:')) {
        processedLines.push(line);
        continue;
      }

      if (!targetUrl.startsWith('http')) {
        targetUrl = baseUrl + targetUrl;
      }

      if (targetUrl.includes('.m3u8')) {
        const proxyUrl = `${proxyBase}/proxy/playlist.m3u8?url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(finalReferer)}${useAbsolute ? '&absolute=true' : ''}`;
        processedLines.push(proxyUrl);
      } else {
        const proxyUrl = `${proxyBase}/proxy/segment?url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(finalReferer)}`;
        processedLines.push(proxyUrl);
      }
    }

    const finalContent = processedLines.join('\n');
    
    console.log(`[Playlist] ✅ Processing complete`);

    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Cache-Control': 'no-cache'
    });

    res.send(finalContent);
  } catch (error) {
    console.error('[Playlist] ❌ Error:', error.message);
    res.status(500).send(`Error fetching playlist: ${error.message}`);
  }
});

app.get('/proxy/segment', async (req, res) => {
  try {
    const { url, referer } = req.query;
    
    if (!url) {
      return res.status(400).send('URL parameter is required');
    }

    const decodedUrl = decodeURIComponent(url);
    const finalReferer = referer || 'https://kwik.cx/';
    const range = req.headers.range;

    const requestHeaders = getHeaders(finalReferer);
    if (range) {
      requestHeaders['Range'] = range;
    }

    const response = await axios.get(decodedUrl, {
      headers: requestHeaders,
      responseType: 'stream',
      timeout: 30000,
      maxRedirects: 5,
      validateStatus: (status) => status < 500
    });

    const contentType = decodedUrl.includes('.m4s') ? 'video/iso.segment' : 'video/mp2t';

    const responseHeaders = {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type, Accept-Ranges',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000'
    };

    if (response.headers['content-length']) {
      responseHeaders['Content-Length'] = response.headers['content-length'];
    }
    
    if (response.headers['content-range']) {
      responseHeaders['Content-Range'] = response.headers['content-range'];
      res.status(206);
    }

    res.set(responseHeaders);
    response.data.pipe(res);

  } catch (error) {
    console.error(`[Segment] ❌ Error:`, error.message);
    if (!res.headersSent) {
      res.status(error.response?.status || 500).send(`Error: ${error.message}`);
    }
  }
});

app.get('/proxy/key', async (req, res) => {
  try {
    const { url, referer } = req.query;
    
    console.log(`[Key] 🔑 KEY REQUEST`);
    
    if (!url) {
      console.log(`[Key] ❌ No URL provided`);
      return res.status(400).send('URL parameter is required');
    }

    const decodedUrl = decodeURIComponent(url);
    const finalReferer = referer || 'https://kwik.cx/';

    console.log(`[Key] Fetching: ${decodedUrl}`);

    const response = await axios.get(decodedUrl, {
      headers: getHeaders(finalReferer),
      responseType: 'arraybuffer',
      timeout: 30000,
      maxRedirects: 5
    });

    const keyLength = response.data.byteLength;
    console.log(`[Key] ✅ Received key: ${keyLength} bytes`);

    if (keyLength !== 16) {
      console.log(`[Key] ⚠️ WARNING: Unexpected key length (expected 16, got ${keyLength})`);
    }

    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': keyLength,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Type',
      'Cache-Control': 'public, max-age=31536000'
    });

    res.send(Buffer.from(response.data));
  } catch (error) {
    console.error('[Key] ❌ Fetch error:', error.message);
    if (!res.headersSent) {
      res.status(error.response?.status || 500).send(`Error: ${error.message}`);
    }
  }
});

// Player with codec detection
app.get('/play', (req, res) => {
  const { url, referer } = req.query;
  
  if (!url) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>M3U8 Player</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; }
          input { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 5px; box-sizing: border-box; }
          button { padding: 10px 20px; background: #007bff; color: white; border: none; cursor: pointer; border-radius: 5px; }
          button:hover { background: #0056b3; }
          label { display: block; margin-top: 15px; font-weight: bold; }
        </style>
      </head>
      <body>
        <h1>🎬 M3U8 Player</h1>
        <form method="GET">
          <label>M3U8 URL:</label>
          <input type="text" name="url" placeholder="https://example.com/playlist.m3u8" required>
          <label>Referer (optional):</label>
          <input type="text" name="referer" placeholder="https://kwik.cx/" value="https://kwik.cx/">
          <button type="submit">▶️ Play</button>
        </form>
      </body>
      </html>
    `);
  }

  const finalReferer = referer || 'https://kwik.cx/';

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>M3U8 Player - Codec Detection</title>
      <style>
        body { margin: 0; padding: 0; background: #000; font-family: Arial, sans-serif; }
        #container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        video { width: 100%; max-height: 80vh; background: #000; }
        #controls { background: #1a1a1a; padding: 15px; border-radius: 5px; margin-top: 10px; }
        .info-box { background: #2a2a2a; color: #fff; padding: 15px; border-radius: 5px; margin: 10px 0; }
        .info-box h3 { margin: 0 0 10px 0; color: #4CAF50; }
        .stat { margin: 5px 0; font-size: 13px; }
        .stat span { color: #4CAF50; }
        #log { color: #0f0; max-height: 200px; overflow-y: auto; padding: 10px; background: #000; border-radius: 5px; font-size: 11px; font-family: monospace; margin-top: 10px; }
        .error { color: #f00; }
        .success { color: #0f0; }
        .warning { color: #ff0; }
        button { padding: 8px 15px; margin: 5px; background: #007bff; color: white; border: none; cursor: pointer; border-radius: 5px; }
        button:hover { background: #0056b3; }
        #codecInfo { background: #1a1a1a; color: #fff; padding: 15px; border-radius: 5px; margin: 10px 0; }
        .codec-test { margin: 5px 0; }
        .supported { color: #4CAF50; }
        .unsupported { color: #f44336; }
      </style>
    </head>
    <body>
      <div id="container">
        <div id="codecInfo">
          <h3>🔍 Codec Detection</h3>
          <div id="browserInfo" style="margin-bottom: 10px; padding: 10px; background: #ff9800; color: #000; border-radius: 5px; display: none;">
            <strong>⚠️ MPEG-TS Not Supported in This Browser</strong><br>
            Your browser can play H.264, but NOT in MPEG-TS (.ts) format.<br>
            <strong>Recommended:</strong> Use Firefox (better TS support) or VLC/MPV (perfect support)
          </div>
          <div id="codecTests">Analyzing...</div>
        </div>

        <video id="video" controls></video>
        
        <div id="controls">
          <button onclick="useHLS()">Try HLS.js</button>
          <button onclick="useNative()">Try Native HLS</button>
          <button onclick="downloadVLC()">📥 Download for VLC</button>
        </div>

        <div class="info-box">
          <h3>📊 Stream Info</h3>
          <div class="stat">Status: <span id="status">Initializing...</span></div>
          <div class="stat">Time: <span id="time">0:00 / 0:00</span></div>
          <div class="stat">Original URL: <span style="word-break: break-all; font-size: 11px;">${url}</span></div>
        </div>

        <div id="log"></div>
      </div>

      <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js"></script>
      <script>
        const video = document.getElementById('video');
        const logDiv = document.getElementById('log');
        const codecTests = document.getElementById('codecTests');
        const statusEl = document.getElementById('status');
        const timeEl = document.getElementById('time');
        const browserInfo = document.getElementById('browserInfo');
        
        const originalUrl = decodeURIComponent('${encodeURIComponent(url)}');
        const proxyUrl = '/proxy/playlist.m3u8?url=' + encodeURIComponent(originalUrl) + '&referer=${encodeURIComponent(finalReferer)}';
        
        let hls = null;

        function log(msg, type = '') {
          const timestamp = new Date().toLocaleTimeString();
          const className = type ? \`class="\${type}"\` : '';
          logDiv.innerHTML += \`<div \${className}>\${timestamp} - \${msg}</div>\`;
          logDiv.scrollTop = logDiv.scrollHeight;
          console.log(msg);
        }

        function updateStatus(msg) {
          statusEl.textContent = msg;
        }

        // Test codec support
        async function testCodecs() {
          const codecs = [
            'video/mp4; codecs="avc1.42E01E"',
            'video/mp4; codecs="avc1.4D401E"',
            'video/mp4; codecs="avc1.64001E"',
            'video/mp4; codecs="hvc1.1.6.L93.90"',
            'video/mp2t; codecs="avc1.42E01E"',
            'video/mp2t',
            'application/vnd.apple.mpegurl'
          ];

          let html = '';
          let hasTsSupport = false;
          
          for (const codec of codecs) {
            const support = video.canPlayType(codec);
            const className = support ? 'supported' : 'unsupported';
            const icon = support ? '✅' : '❌';
            html += \`<div class="codec-test \${className}">\${icon} \${codec}: \${support || 'no'}</div>\`;
            
            if (codec === 'video/mp2t' && support) {
              hasTsSupport = true;
            }
          }

          if (window.MediaSource) {
            html += '<div class="codec-test supported">✅ MediaSource API: yes</div>';
          } else {
            html += '<div class="codec-test unsupported">❌ MediaSource API: no</div>';
          }

          codecTests.innerHTML = html;
          
          // Show warning if no TS support
          if (!hasTsSupport) {
            browserInfo.style.display = 'block';
          }

          // Fetch and analyze the stream
          try {
            const response = await fetch('/api/analyze?url=' + encodeURIComponent(originalUrl));
            const data = await response.json();
            
            html += '<hr><h4>Stream Details:</h4>';
            html += \`<div>Encryption: \${data.hasEncryption ? '🔒 ' + data.encryptionMethod : '🔓 None'}</div>\`;
            if (data.codecs.length > 0) {
              html += \`<div>Codecs: \${data.codecs.join(', ')}</div>\`;
            }
            if (data.variants.length > 0) {
              html += \`<div>Variants: \${data.variants.length} quality levels</div>\`;
              data.variants.forEach((v, i) => {
                html += \`<div style="margin-left: 20px; font-size: 11px;">• \${v.resolution || 'Unknown'} - \${v.codecs || 'Unknown codec'}</div>\`;
              });
            }
            
            codecTests.innerHTML = html;
          } catch (err) {
            log('Failed to analyze stream: ' + err.message, 'error');
          }
        }

        function useHLS() {
          log('🔄 Trying HLS.js...', 'warning');
          updateStatus('Loading HLS.js...');

          if (hls) {
            hls.destroy();
          }

          if (!Hls.isSupported()) {
            log('❌ HLS.js not supported', 'error');
            updateStatus('HLS.js not supported');
            return;
          }

          log('✅ HLS.js version: ' + Hls.version, 'success');

          hls = new Hls({
            debug: false,
            enableWorker: true,
            forceKeyFrameOnDiscontinuity: true,
            backBufferLength: 90,
            maxBufferLength: 30,
            maxBufferSize: 60 * 1000 * 1000,
            maxBufferHole: 0.5,
            startFragPrefetch: true,
            manifestLoadingTimeOut: 30000,
            levelLoadingTimeOut: 30000,
            fragLoadingTimeOut: 30000,
            keyLoadingTimeOut: 30000,
            manifestLoadingMaxRetry: 3,
            levelLoadingMaxRetry: 3,
            fragLoadingMaxRetry: 3,
            keyLoadingMaxRetry: 3,
            xhrSetup: function(xhr, url) {
              const fileName = url.split('?')[0].split('/').pop();
              log('📥 Downloading: ' + fileName);
            }
          });

          hls.loadSource(proxyUrl);
          hls.attachMedia(video);

          hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
            log('✅ Manifest parsed', 'success');
            log(\`📊 Levels: \${data.levels.length}, First level: \${data.firstLevel}\`, 'success');
            if (data.levels[0]) {
              log(\`📺 Video codec: \${data.levels[0].videoCodec || 'unknown'}\`, 'success');
              log(\`🎵 Audio codec: \${data.levels[0].audioCodec || 'unknown'}\`, 'success');
            }
            updateStatus('Ready');
            video.play().catch(e => log('Autoplay blocked: ' + e.message, 'warning'));
          });

          hls.on(Hls.Events.KEY_LOADED, (event, data) => {
            log('✅ Decryption key loaded', 'success');
          });

          hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
            const size = (data.payload.byteLength / 1024).toFixed(1);
            log(\`✅ Fragment #\${data.frag.sn}: \${size}KB\`, 'success');
          });

          hls.on(Hls.Events.ERROR, (event, data) => {
            const fatal = data.fatal;
            log(\`\${fatal ? '❌ FATAL' : '⚠️'} \${data.type}: \${data.details}\`, 'error');
            
            if (fatal && data.details === 'bufferAddCodecError') {
              log('═══════════════════════════════════════', 'error');
              log('🔴 CODEC ERROR - Use VLC or MPV instead!', 'error');
              log('═══════════════════════════════════════', 'error');
            }
          });

          video.addEventListener('timeupdate', () => {
            const c = video.currentTime;
            const d = video.duration;
            if (d > 0) {
              timeEl.textContent = \`\${formatTime(c)} / \${formatTime(d)}\`;
            }
          });
        }

        function useNative() {
          log('🔄 Trying native HLS...', 'warning');
          updateStatus('Loading native HLS...');
          
          if (hls) {
            hls.destroy();
            hls = null;
          }

          if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = proxyUrl;
            log('✅ Native HLS supported (Safari)', 'success');
            video.play().catch(e => log('Autoplay blocked', 'warning'));
          } else {
            log('❌ Native HLS not supported', 'error');
            updateStatus('Not supported');
          }
        }

        function downloadVLC() {
          const vlcUrl = \`http://localhost:${PORT}/proxy/playlist.m3u8?url=\${encodeURIComponent(originalUrl)}&absolute=true\`;
          
          const text = \`VLC/MPV Commands:

VLC:
vlc "\${vlcUrl}"

MPV:
mpv "\${vlcUrl}"

⚠️ Important: Replace 'localhost' with your computer's IP address if needed.

Direct M3U8 URL:
\${originalUrl}\`;

          const blob = new Blob([text], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'stream-info.txt';
          a.click();
          
          log('📥 Downloaded stream info for VLC/MPV', 'success');
        }

        function formatTime(s) {
          if (!s || isNaN(s)) return '0:00';
          const h = Math.floor(s / 3600);
          const m = Math.floor((s % 3600) / 60);
          const sec = Math.floor(s % 60);
          return h > 0 ? \`\${h}:\${m.toString().padStart(2, '0')}:\${sec.toString().padStart(2, '0')}\` 
                       : \`\${m}:\${sec.toString().padStart(2, '0')}\`;
        }

        // Initialize
        testCodecs();
        
        // Auto-start with HLS.js
        setTimeout(() => {
          if (Hls.isSupported()) {
            useHLS();
          } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            useNative();
          } else {
            log('❌ No HLS support detected. Use VLC/MPV instead.', 'error');
            updateStatus('Browser not supported - Use VLC/MPV');
          }
        }, 500);
      </script>
    </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  const host = req.get('host');
  const protocol = req.protocol;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>M3U8 Proxy Server</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; }
        .test-link { display: inline-block; margin: 10px 10px 10px 0; padding: 15px 30px; background: #28a745; color: white; border-radius: 5px; font-weight: bold; text-decoration: none; }
        .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <h1>🎬 M3U8 Proxy Server</h1>
      <p>Server: <strong>${protocol}://${host}</strong></p>
      
      <a href="/play" class="test-link">▶️ Player with Codec Detection</a>
      
      <div class="warning">
        <strong>⚠️ bufferAddCodecError means your browser can't decode the video codec!</strong>
        <br><br>
        <strong>Solutions:</strong>
        <ol>
          <li><strong>Best option:</strong> Use VLC or MPV (they support all codecs)</li>
          <li>Try a different browser (Chrome, Edge, Firefox)</li>
          <li>The video might use H.265/HEVC which isn't widely supported in browsers</li>
        </ol>
      </div>

      <h2>🖥️ For VLC/MPV (Recommended):</h2>
      <p>These players support ALL codecs including H.265:</p>
      <pre style="background: #f4f4f4; padding: 15px; border-radius: 5px;">
vlc "${protocol}://${host}/proxy/playlist.m3u8?url=YOUR_M3U8_URL&absolute=true"

mpv "${protocol}://${host}/proxy/playlist.m3u8?url=YOUR_M3U8_URL&absolute=true"</pre>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`\n🎬 M3U8 Proxy Server (Codec Detection)`);
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`▶️ Player: http://localhost:${PORT}/play\n`);
});