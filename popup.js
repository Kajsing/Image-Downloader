// popup.js

document.getElementById('startBtn').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.scripting.executeScript(
        {
          target: { tabId: tabs[0].id },
          function: collectImages,
        },
        (results) => {
          if (chrome.runtime.lastError) {
            updateStatus('Error: ' + chrome.runtime.lastError.message);
            return;
          }
          const images = results[0].result;
          if (images.length === 0) {
            updateStatus('No images found.');
            return;
          }
          chrome.storage.local.set({ images: images }, () => {
            updateStatus(`Found ${images.length} images.`);
            document.getElementById('saveBtn').disabled = false;
          });
        }
      );
    });
  });
  
  document.getElementById('saveBtn').addEventListener('click', () => {
    chrome.storage.local.get('images', (data) => {
      if (!data.images || data.images.length === 0) {
        updateStatus('No images to save.');
        return;
      }
      downloadImages(data.images);
    });
  });
  
  function updateStatus(message) {
    document.getElementById('status').textContent = message;
  }
  
  // Function to collect images from the webpage
  function collectImages() {
    const imgElements = Array.from(document.images);
    const imgSrcs = imgElements.map(img => img.src);
  
    // Find images that are links to other images
    const linkedImageSrcs = [];
    const anchorElements = Array.from(document.querySelectorAll('a'));
    anchorElements.forEach(a => {
      const href = a.href;
      if (href.match(/\.(jpeg|jpg|gif|png|svg)$/i)) {
        linkedImageSrcs.push(href);
      }
    });
  
    const allImages = Array.from(new Set([...imgSrcs, ...linkedImageSrcs]));
    return allImages;
  }
  
  // Function to download images
  function downloadImages(images) {
    const background = chrome.runtime.getBackgroundPage
      ? chrome.runtime.getBackgroundPage
      : null;
  
    if (background) {
      background.downloadImages(images);
    } else {
      chrome.runtime.sendMessage({ action: 'downloadImages', images: images });
    }
  }
  