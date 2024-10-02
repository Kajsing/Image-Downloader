// background.js

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'downloadImages') {
      downloadFiles(request.images, 'images');
      sendResponse({ status: 'Image batch download started.' });
    }
    
    if (request.action === 'downloadWebmFiles') {
      downloadFiles(request.webmFiles, 'webm');
      sendResponse({ status: 'WebM batch download started.' });
    }
    
    // Indicates that the response will be sent asynchronously
    return true;
  });
  
  // Function to handle downloading files
  function downloadFiles(urls, type) {
    urls.forEach((url, index) => {
      // Extract the filename from the URL
      let filename = url.split('/').pop().split('?')[0] || `${type}_file_${index}`;
  
      // Append appropriate extension if missing
      if (!filename.includes('.')) {
        filename += type === 'images' ? '.png' : '.webm';
      }
  
      // Define the download path
      const downloadPath = type === 'images' ? `ImageDownloader/Images/${filename}` : `ImageDownloader/WebM/${filename}`;
  
      // Initiate the download
      chrome.downloads.download({
        url: url,
        filename: downloadPath,
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
  