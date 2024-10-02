// background.js

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'downloadImages') {
      downloadImages(request.images);
      sendResponse({ status: 'Downloading started' });
    }
  });
  
  function downloadImages(images) {
    images.forEach((url, index) => {
      // Extract the image filename
      const urlParts = url.split('/');
      let filename = urlParts[urlParts.length - 1].split('?')[0]; // Remove query params
  
      // Handle cases where filename might be empty
      if (!filename) {
        filename = `image_${index}.png`;
      }
  
      // Initiate the download
      chrome.downloads.download({
        url: url,
        filename: `ImageDownloader/${filename}`,
        conflictAction: 'uniquify',
        saveAs: false
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error(`Error downloading ${url}: ${chrome.runtime.lastError.message}`);
        } else {
          console.log(`Started download for ${url} with ID ${downloadId}`);
        }
      });
    });
  }
  