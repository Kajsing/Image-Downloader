// popup.js

// Configuration for default batch sizes
const DEFAULT_IMAGE_BATCH_SIZE = 50;
const DEFAULT_WEBM_BATCH_SIZE = 5;

// Retrieve references to DOM elements
const scanImagesBtn = document.getElementById('scanImagesBtn');
const downloadImagesBtn = document.getElementById('downloadImagesBtn');
const imageBatchInfo = document.getElementById('imageBatchInfo');
const imageCountdown = document.getElementById('imageCountdown');
const imageBatchSizeInput = document.getElementById('imageBatchSize');

const scanWebmBtn = document.getElementById('scanWebmBtn');
const downloadWebmBtn = document.getElementById('downloadWebmBtn');
const webmBatchInfo = document.getElementById('webmBatchInfo');
const webmCountdown = document.getElementById('webmCountdown');
const webmBatchSizeInput = document.getElementById('webmBatchSize');

const statusDiv = document.getElementById('status');

// State variables
let imageBatches = [];
let currentImageBatchIndex = 0;
let imageCountdownInterval;
let imageBatchSize = DEFAULT_IMAGE_BATCH_SIZE;

let webmBatches = [];
let currentWebmBatchIndex = 0;
let webmCountdownInterval;
let webmBatchSize = DEFAULT_WEBM_BATCH_SIZE;

// Utility function to update the status message
function updateStatus(message) {
  statusDiv.textContent = message;
}

// Utility function to split a list into batches
function splitIntoBatches(list, batchSize) {
  const batches = [];
  for (let i = 0; i < list.length; i += batchSize) {
    batches.push(list.slice(i, i + batchSize));
  }
  return batches;
}

// Function to handle scanning images
scanImagesBtn.addEventListener('click', () => {
  const excludeExternal = document.getElementById('excludeExternal').checked;
  imageBatchSize = parseInt(imageBatchSizeInput.value) || DEFAULT_IMAGE_BATCH_SIZE;

  updateStatus('Scanning for images...');

  // Get the active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    const tabId = activeTab.id;

    // Execute the collectImages function in the context of the active tab
    chrome.scripting.executeScript(
      {
        target: { tabId: tabId },
        function: collectImages,
        args: [excludeExternal]
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

        // Split images into batches
        imageBatches = splitIntoBatches(images, imageBatchSize);
        currentImageBatchIndex = 0;

        // Store the state in chrome.storage.local with a key unique to the tab
        chrome.storage.local.set({
          [`download_${tabId}`]: {
            type: 'images',
            data: imageBatches,
            currentIndex: currentImageBatchIndex,
            batchSize: imageBatchSize
          }
        }, () => {
          updateStatus(`Found ${images.length} images.`);
          imageBatchInfo.textContent = `Batches: 0/${imageBatches.length}`;
          downloadImagesBtn.disabled = false;
        });
      }
    );
  });
});

// Function to handle downloading the next batch of images
downloadImagesBtn.addEventListener('click', () => {
  // Get the active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    const tabId = activeTab.id;

    // Retrieve the download state for this tab
    chrome.storage.local.get([`download_${tabId}`], (result) => {
      const downloadState = result[`download_${tabId}`];

      if (!downloadState || downloadState.type !== 'images') {
        updateStatus('No images to download. Please scan first.');
        downloadImagesBtn.disabled = true;
        return;
      }

      if (currentImageBatchIndex >= downloadState.data.length) {
        updateStatus('All image batches downloaded.');
        downloadImagesBtn.disabled = true;
        return;
      }

      // Get the current batch to download
      const batch = downloadState.data[currentImageBatchIndex];

      updateStatus(`Downloading image batch ${currentImageBatchIndex + 1} of ${downloadState.data.length}...`);

      // Send a message to the background script to download the batch
      chrome.runtime.sendMessage({ action: 'downloadImages', images: batch }, (response) => {
        if (chrome.runtime.lastError) {
          updateStatus('Error: ' + chrome.runtime.lastError.message);
          return;
        }

        updateStatus(response.status);

        // Update the batch index
        currentImageBatchIndex++;
        imageBatchInfo.textContent = `Batches: ${currentImageBatchIndex}/${downloadState.data.length}`;

        // Update the stored state
        chrome.storage.local.set({
          [`download_${tabId}`]: {
            ...downloadState,
            currentIndex: currentImageBatchIndex
          }
        }, () => {
          if (currentImageBatchIndex < downloadState.data.length) {
            // Start countdown before enabling the download button again
            startImageCountdown();
          } else {
            updateStatus('All image batches downloaded.');
            downloadImagesBtn.disabled = true;
          }
        });
      });
    });
  });
});

// Function to handle scanning WebM files
scanWebmBtn.addEventListener('click', () => {
  webmBatchSize = parseInt(webmBatchSizeInput.value) || DEFAULT_WEBM_BATCH_SIZE;

  updateStatus('Scanning for WebM files...');

  // Get the active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    const tabId = activeTab.id;

    // Execute the collectWebmFiles function in the context of the active tab
    chrome.scripting.executeScript(
      {
        target: { tabId: tabId },
        function: collectWebmFiles
      },
      (results) => {
        if (chrome.runtime.lastError) {
          updateStatus('Error: ' + chrome.runtime.lastError.message);
          return;
        }

        const webmFiles = results[0].result;

        if (webmFiles.length === 0) {
          updateStatus('No WebM files found.');
          return;
        }

        // Split WebM files into batches
        webmBatches = splitIntoBatches(webmFiles, webmBatchSize);
        currentWebmBatchIndex = 0;

        // Store the state in chrome.storage.local with a key unique to the tab
        chrome.storage.local.set({
          [`download_${tabId}`]: {
            type: 'webm',
            data: webmBatches,
            currentIndex: currentWebmBatchIndex,
            batchSize: webmBatchSize
          }
        }, () => {
          updateStatus(`Found ${webmFiles.length} WebM files.`);
          webmBatchInfo.textContent = `Batches: 0/${webmBatches.length}`;
          downloadWebmBtn.disabled = false;
        });
      }
    );
  });
});

// Function to handle downloading the next batch of WebM files
downloadWebmBtn.addEventListener('click', () => {
  // Get the active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    const tabId = activeTab.id;

    // Retrieve the download state for this tab
    chrome.storage.local.get([`download_${tabId}`], (result) => {
      const downloadState = result[`download_${tabId}`];

      if (!downloadState || downloadState.type !== 'webm') {
        updateStatus('No WebM files to download. Please scan first.');
        downloadWebmBtn.disabled = true;
        return;
      }

      if (currentWebmBatchIndex >= downloadState.data.length) {
        updateStatus('All WebM batches downloaded.');
        downloadWebmBtn.disabled = true;
        return;
      }

      // Get the current batch to download
      const batch = downloadState.data[currentWebmBatchIndex];

      updateStatus(`Downloading WebM batch ${currentWebmBatchIndex + 1} of ${downloadState.data.length}...`);

      // Send a message to the background script to download the batch
      chrome.runtime.sendMessage({ action: 'downloadWebmFiles', webmFiles: batch }, (response) => {
        if (chrome.runtime.lastError) {
          updateStatus('Error: ' + chrome.runtime.lastError.message);
          return;
        }

        updateStatus(response.status);

        // Update the batch index
        currentWebmBatchIndex++;
        webmBatchInfo.textContent = `Batches: ${currentWebmBatchIndex}/${downloadState.data.length}`;

        // Update the stored state
        chrome.storage.local.set({
          [`download_${tabId}`]: {
            ...downloadState,
            currentIndex: currentWebmBatchIndex
          }
        }, () => {
          if (currentWebmBatchIndex < downloadState.data.length) {
            // Start countdown before enabling the download button again
            startWebmCountdown();
          } else {
            updateStatus('All WebM batches downloaded.');
            downloadWebmBtn.disabled = true;
          }
        });
      });
    });
  });
});

// Function to start the countdown for Images
function startImageCountdown() {
  let timeLeft = COUNTDOWN_SECONDS;
  imageCountdown.textContent = `Next image batch in ${timeLeft} seconds...`;

  imageCountdownInterval = setInterval(() => {
    timeLeft--;
    if (timeLeft > 0) {
      imageCountdown.textContent = `Next image batch in ${timeLeft} seconds...`;
    } else {
      clearInterval(imageCountdownInterval);
      imageCountdown.textContent = 'You can download the next image batch now.';
      downloadImagesBtn.disabled = false;
    }
  }, 1000);
}

// Function to start the countdown for WebM
function startWebmCountdown() {
  let timeLeft = COUNTDOWN_SECONDS;
  webmCountdown.textContent = `Next WebM batch in ${timeLeft} seconds...`;

  webmCountdownInterval = setInterval(() => {
    timeLeft--;
    if (timeLeft > 0) {
      webmCountdown.textContent = `Next WebM batch in ${timeLeft} seconds...`;
    } else {
      clearInterval(webmCountdownInterval);
      webmCountdown.textContent = 'You can download the next WebM batch now.';
      downloadWebmBtn.disabled = false;
    }
  }, 1000);
}

// Restore state when the popup is opened
document.addEventListener('DOMContentLoaded', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    const tabId = activeTab.id;

    // Retrieve the download state for Images
    chrome.storage.local.get([`download_${tabId}`], (result) => {
      const downloadState = result[`download_${tabId}`];

      if (downloadState && downloadState.type === 'images') {
        imageBatches = downloadState.data;
        currentImageBatchIndex = downloadState.currentIndex;
        imageBatchSizeInput.value = downloadState.batchSize;
        imageBatchInfo.textContent = `Batches: ${currentImageBatchIndex}/${imageBatches.length}`;

        if (currentImageBatchIndex < imageBatches.length) {
          downloadImagesBtn.disabled = false;
          updateStatus(`Found ${imageBatches.flat().length} images.`);
        }
      }

      if (downloadState && downloadState.type === 'webm') {
        webmBatches = downloadState.data;
        currentWebmBatchIndex = downloadState.currentIndex;
        webmBatchSizeInput.value = downloadState.batchSize;
        webmBatchInfo.textContent = `Batches: ${currentWebmBatchIndex}/${webmBatches.length}`;

        if (currentWebmBatchIndex < webmBatches.length) {
          downloadWebmBtn.disabled = false;
          updateStatus(`Found ${webmBatches.flat().length} WebM files.`);
        }
      }
    });
  });
});

// Function injected into the webpage to collect image URLs
function collectImages(excludeExternal) {
  const currentUrl = new URL(window.location.href);
  const currentHost = currentUrl.host;

  // Collect all image sources
  const imgElements = Array.from(document.images);
  let imgSrcs = imgElements.map(img => img.src);

  // Find images that are linked directly via anchor tags
  const linkedImageSrcs = [];
  const anchorElements = Array.from(document.querySelectorAll('a'));
  anchorElements.forEach(a => {
    const href = a.href;
    if (href.match(/\.(jpeg|jpg|gif|png|svg)$/i)) {
      linkedImageSrcs.push(href);
    }
  });

  imgSrcs = imgSrcs.concat(linkedImageSrcs);

  // Remove duplicates
  imgSrcs = Array.from(new Set(imgSrcs));

  if (excludeExternal) {
    imgSrcs = imgSrcs.filter(src => {
      try {
        const srcHost = new URL(src).host;
        return srcHost === currentHost;
      } catch (e) {
        // If URL parsing fails, exclude the image
        return false;
      }
    });
  }

  return imgSrcs;
}

// Function injected into the webpage to collect WebM file URLs
function collectWebmFiles() {
  // Collect all video elements
  const videoElements = Array.from(document.querySelectorAll('video'));
  let webmFiles = [];

  videoElements.forEach(video => {
    if (video.currentSrc && video.currentSrc.endsWith('.webm')) {
      webmFiles.push(video.currentSrc);
    }
    // Also check sources within <source> tags
    const sourceElements = Array.from(video.querySelectorAll('source'));
    sourceElements.forEach(source => {
      const src = source.src;
      if (src && src.endsWith('.webm')) {
        webmFiles.push(src);
      }
    });
  });

  // Additionally, look for direct links to .webm files
  const anchorElements = Array.from(document.querySelectorAll('a'));
  anchorElements.forEach(a => {
    const href = a.href;
    if (href.match(/\.webm$/i)) {
      webmFiles.push(href);
    }
  });

  // Remove duplicates
  webmFiles = Array.from(new Set(webmFiles));

  return webmFiles;
}
