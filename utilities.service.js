const https = require('https');

async function downloadImage(url) {
  // Check if the URL is a data URL
  if (url.startsWith('data:')) {
    const matches = url.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (matches.length !== 3) {
      throw new Error('Invalid data URL');
    }
    return {
      mimeType: matches[1],
      data: matches[2]
    };
  }

  // If it's not a data URL, proceed with HTTPS download
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to fetch image: ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const mimeType = response.headers['content-type'];
        const data = buffer.toString('base64');
        resolve({ data, mimeType });
      });
    }).on('error', reject);
  });
}

module.exports = { downloadImage };
