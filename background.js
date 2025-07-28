let activeFileName = '';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background received message:', message);

  if (message.action === 'statusUpdate') {
    if (message.contacts && message.contacts.length > 0) {
      chrome.storage.local.get(['contacts'], (result) => {
        const storedData = result.contacts || [];
        const updatedData = [...storedData, ...message.contacts];
        chrome.storage.local.set({ contacts: updatedData }, () => {
          if (chrome.runtime.lastError) {
            console.error('Storage error:', chrome.runtime.lastError.message);
            sendResponse({ status: 'error', error: chrome.runtime.lastError.message });
          } else {
            console.log('Stored contacts:', updatedData.length);
            sendResponse({ status: 'success' });
          }
        });
      });
    } else {
      console.log('Status update received:', message);
      sendResponse({ status: 'success' });
    }
  }

  if (message.action === 'GET_ACTIVE_FILE') {
    sendResponse({ fileName: activeFileName });
  } else if (message.action === 'UPDATE_ACTIVE_FILE') {
    activeFileName = message.fileName || '';
    chrome.storage.local.set({ activeFileName }, () => {
      console.log('Active file updated:', activeFileName);
      sendResponse({ status: 'updated', fileName: activeFileName });
    });
  }

  if (message.action === 'fetchFirmableListData' && message.listId) {
    const url = `https://api.firmable.com/internal/list/${message.listId}`;
    fetch(url, {
      credentials: 'include',
      headers: {
        'Accept': 'application/json'
      }
    })
      .then(async (resp) => {
        if (!resp.ok) {
          const text = await resp.text();
          sendResponse({ error: true, status: resp.status, message: text });
          return;
        }
        const data = await resp.json();
        sendResponse({ error: false, data });
      })
      .catch((err) => {
        sendResponse({ error: true, message: err.message });
      });
    return true; // Keep the message channel open for async response
  }

  return true;
});

// Trigger modal on extension icon click with retry mechanism
chrome.action.onClicked.addListener((tab) => {
  if (
    tab.url &&
    (
      tab.url.startsWith('https://www.linkedin.com/sales/search/people') ||
      tab.url.startsWith('https://www.linkedin.com/sales/search/company') ||
      /^https:\/\/app\.firmable\.com(\/dashboard)?\/list\/[a-f0-9\-]+/i.test(tab.url)
    )
  ) {
    // Function to attempt sending the openModal message with retries
    function trySendMessage(tabId, retries = 3, delay = 1000) {
      chrome.tabs.sendMessage(tabId, { action: 'openModal' }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn(`Error sending openModal message: ${chrome.runtime.lastError.message}, retries left: ${retries}`);
          if (retries > 0) {
            // Retry after a delay
            setTimeout(() => trySendMessage(tabId, retries - 1, delay), delay);
          } else {
            // Fallback: Dynamically inject content.js and try again
            console.log('Attempting to dynamically inject content.js');
            chrome.scripting.executeScript({
              target: { tabId: tabId },
              files: ['content.js']
            }, () => {
              if (chrome.runtime.lastError) {
                console.error('Error injecting content.js:', chrome.runtime.lastError.message);
                chrome.notifications.create({
                  type: 'basic',
                  iconUrl: 'icons/pngimg.com - magnet_PNG103227.png',
                  title: 'Extension Error',
                  message: 'Failed to open modal. Please ensure the page is fully loaded and try again.'
                });
                return;
              }
              // Try sending the message one more time after injection
              chrome.tabs.sendMessage(tabId, { action: 'openModal' }, (response) => {
                if (chrome.runtime.lastError) {
                  console.error('Error opening modal after injection:', chrome.runtime.lastError.message);
                } else {
                  console.log('Modal opened:', response);
                }
              });
            });
          }
        } else {
          console.log('Modal opened:', response);
        }
      });
    }

    // Start the message sending process
    trySendMessage(tab.id);
  } else {
    console.warn('Extension only works on LinkedIn Sales Navigator search pages and Firmable list pages.');
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/pngimg.com - magnet_PNG103227.png',
      title: 'Extension Info',
      message: 'Please navigate to a LinkedIn Sales Navigator search page (e.g., https://www.linkedin.com/sales/search/people or /company) or a Firmable list page (e.g., https://app.firmable.com/list/{id}) to use this extension.'
    });
  }
});

// Keep-alive to prevent service worker inactivity
setInterval(() => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'KEEP_ALIVE' }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('Keep-alive failed:', chrome.runtime.lastError.message);
        }
      });
    }
  });
}, 30000);

chrome.runtime.onStartup.addListener(() => {
  console.log('Service worker started');
});

console.log('Background script loaded');