(function() {
  // Prevent multiple executions
  if (window.pagePilotInitialized) return;
  window.pagePilotInitialized = true;

  // Log initialization for debugging
  console.log('Content script initialized');

  // Initialize global variables
  let currentPage = 1;
  let pageLimit = 1;
  let isScraping = false;
  let totalProspects = 0;
  let allScrapedContacts = [];
  let totalPages = 0;
  let scrapedPages = 0;
  let totalScrapedSoFar = 0;
  let estimatedTotalContacts = 10;
  let scrapeMode = 'leads'; // 'leads' or 'accounts'
  let actualTotalResults = null;
  const companyDataMap = new Map();
  let scrapedAccountsData = []; // Store scraped accounts for export

  function getCsrfToken() {
    const match = document.cookie.match(/JSESSIONID\s*=\s*"?(.*?)"?;/);
    if (match) return match[1].replace(/^"/, '').replace(/"$/, '');
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }

  function getCurrentPageNumber() {
    const urlParams = new URLSearchParams(window.location.search);
    const page = parseInt(urlParams.get('page'), 10);
    return isNaN(page) ? 1 : page;
  }

  // Simplified decoration to get core company data
  const decoration = '(entityUrn,name,companyName,description,industry,employeeCount,employeeDisplayCount,' +
    'employeeCountRange,location,headquarters,website,revenue,formattedRevenue,revenueRange,' +
    'annualRevenue,flagshipCompanyUrl,companyUrl,websiteUrl,primaryLocation,geographicArea)';

  async function fetchCompanyData(companyUrn) {
    if (!companyUrn) return { employeeCount: null, location: null, geographicArea: null, industry: null, website: null, flagshipCompanyUrl: null };
    
    const companyId = companyUrn.split(':').pop();
    if (companyDataMap.has(companyId)) return companyDataMap.get(companyId);

    const url = `https://www.linkedin.com/sales-api/salesApiCompanies/${companyId}?decoration=${decoration}`;
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: {
          'Csrf-Token': getCsrfToken(),
          'x-restli-protocol-version': '2.0.0',
          'Accept': 'application/json, */*'
        }
      });
      if (!resp.ok) return { employeeCount: null, location: null, geographicArea: null, industry: null, website: null, flagshipCompanyUrl: null };
      const json = await resp.json();
      const companyData = {
        employeeCount: json.employeeCount || null,
        location: json.location || json.headquarters?.city || null,
        geographicArea: json.headquarters?.geographicArea || null,
        industry: json.industry || null,
        website: json.website || null,
        flagshipCompanyUrl: json.flagshipCompanyUrl || null
      };
      companyDataMap.set(companyId, companyData);
      return companyData;
    } catch (error) {
      console.error('Error fetching company data:', error);
      return { employeeCount: null, location: null, geographicArea: null, industry: null, website: null, flagshipCompanyUrl: null };
    }
  }

  async function searchPeople(params = {}) {
    const urlParams = new URLSearchParams(window.location.search);
    const savedSearchId = urlParams.get('savedSearchId');
    const sessionId = urlParams.get('sessionId');

    if (!savedSearchId || !sessionId) throw new Error('Missing savedSearchId or sessionId');

    const queryParams = new URLSearchParams({
      q: 'savedSearchId',
      start: params.start?.toString() || '0',
      count: params.count?.toString() || '25',
      savedSearchId,
      sessionId,
      decorationId: 'com.linkedin.sales.deco.desktop.searchv2.LeadSearchResult-14'
    });

    const headers = {
      'Csrf-Token': getCsrfToken(),
      'Accept': 'application/json',
      'x-restli-protocol-version': '2.0.0',
      'x-li-lang': 'en_US',
      'x-li-track': '{"clientVersion":"2.0.0","osName":"web","osVersion":"unknown","deviceType":"desktop"}',
      'x-li-page-instance': 'urn:li:page:sales/search',
      'x-source': 'sales-navigator'
    };

    const apiUrl = `https://www.linkedin.com/sales-api/salesApiLeadSearch?${queryParams.toString()}`;
    await new Promise(resolve => setTimeout(resolve, 5000));

    try {
      const response = await fetch(apiUrl, { method: 'GET', headers, credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error('Error searching people:', error);
      throw error;
    }
  }

  async function sendToServer(scrapeData, attempt = 1) {
    const maxAttempts = 3;
    const serverUrl = 'http://localhost:5000/api/scrapes';
    const chunkSize = 10;

    try {
      const contacts = scrapeData.contacts || [];
      for (let i = 0; i < contacts.length; i += chunkSize) {
        const chunk = contacts.slice(i, i + chunkSize);
        const chunkData = { ...scrapeData, contacts: chunk };
        const response = await Promise.race([
          fetch(serverUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(chunkData),
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 60000))
        ]);
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
      }
      return { status: 'success' };
    } catch (error) {
      console.error(`Send to server attempt ${attempt} failed:`, error);
      if (attempt < maxAttempts) return sendToServer(scrapeData, attempt + 1);
      chrome.storage.local.get(['contacts'], (result) => {
        const storedData = result.contacts || [];
        chrome.storage.local.set({ contacts: [...storedData, ...scrapeData.contacts] }, () => {
          console.log('Stored contacts locally due to server failure');
        });
      });
      throw error;
    }
  }

  function updateUI(state) {
    const event = new CustomEvent('pagePilotUpdate', { detail: state });
    document.dispatchEvent(event);
  }

  async function scrapeCurrentPage() {
    try {
      const apiResponse = await searchPeople({ count: 25, start: (currentPage - 1) * 25 });
      if (apiResponse?.paging?.total) {
        actualTotalResults = apiResponse.paging.total;
      }
      if (!apiResponse?.elements?.length) {
        updateUI({ statusMessage: `⚠️ No contacts on page ${currentPage}` });
        return [];
      }

      totalProspects += apiResponse.elements.length;
      const pageResults = [];
      for (const elem of apiResponse.elements) {
        const companyUrn = elem.currentPositions?.[0]?.companyUrn || '';
        const companyData = await fetchCompanyData(companyUrn);
        pageResults.push({
          firstName: elem.firstName || '',
          lastName: elem.lastName || '',
          fullName: elem.fullName || '',
          title: elem.currentPositions?.[0]?.title || '',
          companyName: elem.currentPositions?.[0]?.companyName || '',
          premium: elem.premium || false,
          openLink: elem.openLink || false,
          companyUrn,
          profileUrl: (() => {
            const match = elem.entityUrn && elem.entityUrn.match(/\(([^,]+),/);
            return match ? `https://www.linkedin.com/in/${match[1]}` : '';
          })(),
          company: companyData
        });
      }

      const scrapeData = { name: localStorage.getItem('currentFileName') || 'Default', contacts: pageResults, pageNumber: currentPage };
      await sendToServer(scrapeData);
      
      updateUI({ 
        statusMessage: `✅ Page ${currentPage}: ${pageResults.length} contacts scraped.`,
        progress: (currentPage / pageLimit) * 100,
        scrapingPage: currentPage,
      });

      return pageResults;
    } catch (error) {
      console.error('Error scraping current page:', error);
      updateUI({ statusMessage: `⚠️ Error on page ${currentPage}: ${error.message}` });
      return [];
    }
  }

  async function scrapeAllPages(pagesToScrape) {
    allScrapedContacts = [];
    const startPage = getCurrentPageNumber();
    currentPage = startPage;
    pageLimit = startPage + pagesToScrape - 1;

    while (isScraping && currentPage <= pageLimit) {
      const pageContacts = await scrapeCurrentPage();
      allScrapedContacts = [...allScrapedContacts, ...pageContacts];
      
      const scrapedPageCount = currentPage - startPage + 1;
      const totalPagesToScrape = pageLimit - startPage + 1;
      updateUI({
        progress: (scrapedPageCount / totalPagesToScrape) * 100,
        scrapingPage: currentPage,
        statusMessage: `Scraping page ${currentPage}...`
      });

      if (pageContacts.length === 0) {
        updateUI({ statusMessage: `Stopping: No contacts found on page ${currentPage}.` });
        break;
      }
      
      currentPage++;
      if (isScraping && currentPage <= pageLimit) {
        await goToNextPage();
      }
    }
    return allScrapedContacts;
  }

  async function goToNextPage() {
    const url = new URL(window.location.href);
    url.searchParams.set('page', currentPage.toString());
    window.history.pushState({}, '', url);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  window.lastScrapedAccounts = [];

  function getFirmableListId() {
    const match = window.location.pathname.match(/(?:\/dashboard)?\/list\/([a-f0-9\-]+)/i);
    return match ? match[1] : null;
  }

  function getPageType() {
    if (window.location.pathname.startsWith('/sales/search/people')) return 'leads';
    if (window.location.pathname.startsWith('/sales/search/company')) return 'accounts';
    if (window.location.hostname.includes('firmable.com') && getFirmableListId()) return 'firmable';
    return 'unknown';
  }

  async function fetchAndSetTotalResults() {
    try {
      const apiResponse = await searchPeople({ count: 1, start: 0 });
      if (apiResponse?.paging?.total) {
        actualTotalResults = apiResponse.paging.total;
        updateUI({ actualTotalResults });
      }
    } catch (e) {
      console.error('Error fetching total results:', e);
    }
  }

  async function fetchFirmableListData(listId) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'fetchFirmableListData', listId }, (response) => {
        if (!response) {
          reject(new Error('No response from background script'));
        } else if (response.error) {
          reject(new Error(response.message || `HTTP error: ${response.status}`));
        } else {
          resolve(response.data);
        }
      });
    });
  }

  async function scrapeFirmableList() {
    const listId = getFirmableListId();
    if (!listId) {
      updateUI({ statusMessage: 'Firmable list ID not found in URL.' });
      return [];
    }
    try {
      const data = await fetchFirmableListData(listId);
      let contacts = [];
      if (Array.isArray(data.items)) {
        contacts = data.items;
      } else if (Array.isArray(data.results)) {
        contacts = data.results;
      } else if (Array.isArray(data.data)) {
        contacts = data.data;
      } else if (Array.isArray(data)) {
        contacts = data;
      } else {
        for (const key in data) {
          if (Array.isArray(data[key])) {
            contacts = data[key];
            break;
          }
        }
      }
      if (contacts.length === 0) contacts = [data];

      const scrapeData = { name: `Firmable List ${listId}`, contacts, pageNumber: 1 };
      await sendToServer(scrapeData);

      updateUI({ statusMessage: `✅ Firmable list: ${contacts.length} records scraped.` });
      return contacts;
    } catch (error) {
      console.error('Error scraping Firmable list:', error);
      updateUI({ statusMessage: `⚠️ Error scraping Firmable: ${error.message}` });
      return [];
    }
  }

  function createModal() {
    if (document.getElementById('pagepilot-root')) return;

    const root = document.createElement('div');
    root.id = 'pagepilot-root';
    document.body.appendChild(root);

    const style = document.createElement('style');
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');
      
      #pagepilot-root {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: rgba(0, 0, 0, 0.5);
        z-index: 10000;
        font-family: 'Poppins', sans-serif;
      }
      .pagepilot-card {
        background: white;
        color: #333;
        border-radius: 24px;
        box-shadow: 0 10px 15px -3px rgba(30, 29, 29, 0.51), 0 4px 6px -2px rgba(7, 77, 253, 0.51);
        width: 30%;
        max-width: 300px;
        position: relative;
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 24px;
        text-align: center;
      }
      .pagepilot-card-header { text-align: center; }
      .pagepilot-card-title { font-size: 2rem; font-weight: 700; color: #1D81F2; margin-bottom: 8px; }
      .pagepilot-card-description { color: #666; font-size: 1rem; line-height: 1.5; }
      
      .pagepilot-tabs { display: flex; justify-content: center; width: 100%; }
      .pagepilot-tabs-list { display: flex; background-color: #f0f0f0; border-radius: 12px; padding: 4px; }
      .pagepilot-tabs-trigger { padding: 10px 24px; border-radius: 8px; background: transparent; border: 0; font-weight: 500; cursor: pointer; color: #666; transition: all 0.2s ease-in-out; }
      .pagepilot-tabs-trigger[data-state="active"] { background: #1D81F2; color: white; }
      
      .pagepilot-roller-container { display: flex; align-items: center; justify-content: center; gap: 24px; width: 100%; }
      .pagepilot-roller-display { font-size: 3rem; font-weight: 700; color: #333; min-width: 80px; text-align: center; }
      .pagepilot-roller-button { display: inline-flex; align-items: center; justify-content: center; border-radius: 9999px; font-weight: 500; transition: background-color 0.2s; height: 48px; width: 48px; border: 0; background: #f0f0f0; color: #333; font-size: 2rem; line-height: 1; }
      .pagepilot-roller-button:disabled { opacity: 0.5; cursor: not-allowed; }
      .pagepilot-roller-button:not(:disabled):hover { background-color: #e0e0e0; }

      .pagepilot-manual-input-container { width: 100%; }
      .pagepilot-manual-input { text-align: center; font-size: 1.5rem; height: 60px; width: 100%; border-radius: 12px; border: 1px solid #ccc; padding: 0.5rem 0.75rem; }
      .pagepilot-manual-input.error { border-color: #D32F2F; }
      
      .pagepilot-quick-select-container { display: flex; justify-content: center; gap: 12px; width: 100%; }
      .pagepilot-quick-select-button { background-color: #f0f0f0; color: #424242; border: 0; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: 500; }
      .pagepilot-quick-select-button:not(:disabled):hover { background-color: #e0e0e0; }
      .pagepilot-quick-select-button.active { background-color: #1D81F2; color: white; }

      .pagepilot-info-text, .pagepilot-error-message { font-size: 0.875rem; color: #757575; text-align: center; margin-top: 4px; min-height: 20px;}
      .pagepilot-error-message { color: #D32F2F; }

      .pagepilot-progress-container { width: 100%; text-align: center; }
      .pagepilot-progress-bar-bg { height: 8px; width: 80%; margin-left: 30px; background-color: #e0e0e0; border-radius: 9999px; overflow: hidden; margin-bottom: 8px; }
      .pagepilot-progress-bar-fg { height: 100%; width: 0%; background-color: #1D81F2; transition: width 0.3s ease-in-out; }
      
      .pagepilot-footer-button {
        width: 80%;
        margin-left: 30px;
        height: 52px;
        font-size: 1.125rem;
        font-weight: 600;
        background-color: #1D81F2;
        color: white;
        border: 0;
        border-radius: 12px;
        cursor: pointer;
        transition: background-color 0.2s;
      }

      .pagepilot-export-button {
        width: 80%;
        margin-left: 30px;
        height: 52px;
        font-size: 1.125rem;
        font-weight: 600;
        background-color: #28a745;
        color: white;
        border: 0;
        border-radius: 12px;
        cursor: pointer;
        transition: background-color 0.2s;
        margin-bottom: 12px;
      }

      .pagepilot-export-button:hover {
        background-color: #218838;
      }

      .pagepilot-footer-button:disabled {
        background-color: #ccc;
        cursor: not-allowed;
      }

      .pagepilot-close-button { width:100%; background:transparent; border:0; color: #757575; cursor:pointer; margin-top: 1rem; padding: 0.5rem; font-weight: 500; }
    `;
    document.head.appendChild(style);

    let pageCount = 1;
    let inputValue = '1';
    let error = null;
    let activeTab = 'manual';
    let isScrapingUI = false;
    let progress = 0;
    let scrapingPage = 0;
    let statusMessage = '';
    let showExportButton = false;

    fetchAndSetTotalResults();
    
    // Check if there's previously scraped account data
    const pageType = getPageType();
    if (pageType === 'accounts') {
      chrome.storage.local.get(['scrapedAccountsData'], (result) => {
        if (result.scrapedAccountsData && result.scrapedAccountsData.length > 0) {
          scrapedAccountsData = result.scrapedAccountsData;
          updateUI({ 
            showExportButton: true,
            statusMessage: `${scrapedAccountsData.length} previously scraped accounts available for export.`
          });
        }
      });
    }

    function render() {
      const pageType = getPageType();
      let modeText = 'PagePilot';
      let startButtonText = 'Start';
      let descriptionText = "Automate your lead generation process. Find your next customer.";
      let showPageCountSelector = true;
      if (pageType === 'leads') {
        modeText = 'Lead Scraping';
        startButtonText = 'Scrape Leads';
      } else if (pageType === 'accounts') {
        modeText = 'Account Scraping';
        startButtonText = 'Scrape Accounts';
      } else if (pageType === 'firmable') {
        modeText = 'Firmable Scraping';
        startButtonText = 'Scrape Firmable List';
        showPageCountSelector = false;
      }
      const current_page_number = getCurrentPageNumber();
      let startLead = ((current_page_number - 1) * 25) + 1;
      let endLead = actualTotalResults ? Math.min(((current_page_number - 1 + pageCount) * 25), actualTotalResults) : ((current_page_number - 1 + pageCount) * 25);
      statusMessage = pageType === 'firmable' ? 'This will scrape all available data from this Firmable list.' : `This will scrape leads from ${startLead} to ${endLead}.`;
      const actualResultsHtml = actualTotalResults && pageType !== 'firmable' ? `<p class="pagepilot-info-text"><strong><h6>Numbers of Leads in this Search: ${actualTotalResults}</h6></strong></p>` : '';

      const contentHtml = `
        <div class="pagepilot-card-header">
          <h2 class="pagepilot-card-title">${modeText}</h2>
          <p class="pagepilot-card-description">${descriptionText}</p>
        </div>
        ${actualResultsHtml}
        <div class="pagepilot-tabs">
          <div class="pagepilot-tabs-list">
            <button class="pagepilot-tabs-trigger" data-tab="manual" data-state="${activeTab === 'manual' ? 'active' : ''}" ${isScrapingUI || !showPageCountSelector ? 'disabled' : ''}>Manual</button>
            <button class="pagepilot-tabs-trigger" data-tab="quick" data-state="${activeTab === 'quick' ? 'active' : ''}" ${isScrapingUI || !showPageCountSelector ? 'disabled' : ''}>Quick Select</button>
          </div>
        </div>
        
        ${showPageCountSelector && activeTab === 'manual' ? `
          <div class="pagepilot-roller-container">
            <button id="decrement-btn" class="pagepilot-roller-button" ${pageCount <= 1 || isScrapingUI ? 'disabled' : ''}>-</button>
            <div class="pagepilot-roller-display">${pageCount}</div>
            <button id="increment-btn" class="pagepilot-roller-button" ${pageCount >= 999 || isScrapingUI ? 'disabled' : ''}>+</button>
          </div>
        ` : ''}
        ${showPageCountSelector && activeTab === 'quick' ? `
          <div class="pagepilot-quick-select-container">
            <button class="pagepilot-quick-select-button ${pageCount === 60 ? 'active' : ''}" data-value="60" ${isScrapingUI ? 'disabled' : ''}>60</button>
            <button class="pagepilot-quick-select-button ${pageCount === 80 ? 'active' : ''}" data-value="80" ${isScrapingUI ? 'disabled' : ''}>80</button>
            <button class="pagepilot-quick-select-button ${pageCount === 100 ? 'active' : ''}" data-value="100" ${isScrapingUI ? 'disabled' : ''}>100</button>
          </div>
        ` : ''}
        
        <p class="pagepilot-info-text">${showPageCountSelector ? 'Select the number of pages to scrape' : ''}</p>
        <p class="pagepilot-info-text">${isScrapingUI ? '' : statusMessage}</p>
        
        <div class="pagepilot-progress-container" style="display: ${isScrapingUI ? 'block' : 'none'}">
          <div class="pagepilot-progress-bar-bg"><div class="pagepilot-progress-bar-fg" style="width: ${progress}%"></div></div>
          <p class="pagepilot-info-text">Scraping page <strong>${scrapingPage}</strong> of <strong>${pageLimit}</strong>...</p>
        </div>
        
        ${showExportButton && pageType === 'accounts' ? `
          <button id="export-csv-btn" class="pagepilot-export-button">
            📊 Export ${scrapedAccountsData.length} Accounts to CSV
          </button>
          <button id="clear-data-btn" class="pagepilot-close-button" style="color: #dc3545; font-weight: 600;">
            🗑️ Clear Scraped Data
          </button>
        ` : ''}

        <button id="start-scraping-btn" class="pagepilot-footer-button" ${isScrapingUI ? 'disabled' : ''}>
          ${isScrapingUI ? 'Scraping...' : startButtonText}
        </button>

        <button id="close-modal-btn" class="pagepilot-close-button">Close</button>
      `;

      root.innerHTML = `<div class="pagepilot-card">${contentHtml}</div>`;
      addEventListeners();
    }

    function addEventListeners() {
      document.getElementById('close-modal-btn')?.addEventListener('click', () => {
        isScraping = false;
        const rootEl = document.getElementById('pagepilot-root');
        if (rootEl) document.body.removeChild(rootEl);
      });

      document.getElementById('decrement-btn')?.addEventListener('click', () => {
        pageCount = Math.max(1, pageCount - 1);
        render();
      });
      document.getElementById('increment-btn')?.addEventListener('click', () => {
        pageCount = Math.min(999, pageCount + 1);
        render();
      });

      document.querySelectorAll('.pagepilot-tabs-trigger').forEach(btn => {
        btn.addEventListener('click', () => {
          activeTab = btn.dataset.tab;
          render();
        });
      });

      document.querySelectorAll('.pagepilot-quick-select-button').forEach(btn => {
        btn.addEventListener('click', () => {
          pageCount = parseInt(btn.dataset.value, 10);
          render();
        });
      });

      document.getElementById('export-csv-btn')?.addEventListener('click', () => {
        exportAccountsToCSV();
      });

      document.getElementById('clear-data-btn')?.addEventListener('click', () => {
        if (confirm('Are you sure you want to clear all scraped account data? This action cannot be undone.')) {
          clearScrapedData();
        }
      });

      document.getElementById('start-scraping-btn')?.addEventListener('click', () => {
        if (isScraping) return;
        isScraping = true;
        
        const startPage = getCurrentPageNumber();
        pageLimit = startPage + pageCount - 1;

        updateUI({ 
          isScrapingUI: true, 
          progress: 0, 
          scrapingPage: startPage, 
          statusMessage: 'Starting scrape...',
          showExportButton: false
        });

        const pageType = getPageType();
        if (pageType === 'leads') {
          scrapeAllPages(pageCount).then(() => {
            isScraping = false;
            updateUI({ isScrapingUI: false, statusMessage: `🎉 Scraping completed for ${totalProspects} contacts.` });
          }).catch((error) => {
            console.error('Lead scraping failed:', error);
            isScraping = false;
            updateUI({ isScrapingUI: false, statusMessage: '⚠️ Lead scraping failed.' });
          });
        } else if (pageType === 'accounts') {
          scrapeAccountsAllPages(pageCount).then((scraped) => {
            isScraping = false;
            window.lastScrapedAccounts = scraped;
            
            // Save scraped data to Chrome storage
            chrome.storage.local.set({ scrapedAccountsData }, () => {
              console.log('Scraped accounts data saved to storage:', scrapedAccountsData.length);
            });
            
            updateUI({ 
              isScrapingUI: false, 
              statusMessage: `🎉 Account scraping completed. ${scrapedAccountsData.length} accounts ready for export.`,
              showExportButton: true
            });
          }).catch((error) => {
            console.error('Account scraping failed:', error);
            isScraping = false;
            updateUI({ isScrapingUI: false, statusMessage: '⚠️ Account scraping failed.' });
          });
        } else if (pageType === 'firmable') {
          scrapeFirmableList().then(() => {
            isScraping = false;
            updateUI({ isScrapingUI: false, statusMessage: `🎉 Firmable scraping completed.` });
          }).catch((error) => {
            console.error('Firmable scraping failed:', error);
            isScraping = false;
            updateUI({ isScrapingUI: false, statusMessage: '⚠️ Firmable scraping failed.' });
          });
        }
      });
    }
    
    document.addEventListener('pagePilotUpdate', (e) => {
      const newState = e.detail;
      if (typeof newState.isScrapingUI !== 'undefined') isScrapingUI = newState.isScrapingUI;
      if (typeof newState.progress !== 'undefined') progress = newState.progress;
      if (typeof newState.scrapingPage !== 'undefined') scrapingPage = newState.scrapingPage;
      if (typeof newState.statusMessage !== 'undefined') statusMessage = newState.statusMessage;
      if (typeof newState.actualTotalResults !== 'undefined') actualTotalResults = newState.actualTotalResults;
      if (typeof newState.showExportButton !== 'undefined') showExportButton = newState.showExportButton;
      render();
    });
    
    render();
  }

  async function scrapeAccountsAllPages(pagesToScrape) {
    allScrapedContacts = [];
    scrapedAccountsData = []; // Reset scraped accounts data
    const startPage = getCurrentPageNumber();
    currentPage = startPage;
    pageLimit = startPage + pagesToScrape - 1;

    let allAccounts = [];
    
    while (isScraping && currentPage <= pageLimit) {
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const savedSearchId = urlParams.get('savedSearchId');
        const sessionId = urlParams.get('sessionId');
        if (!savedSearchId || !sessionId) {
          updateUI({ statusMessage: 'Missing savedSearchId or sessionId in URL' });
          break;
        }
        const queryParams = new URLSearchParams({
          q: 'savedSearch',
          start: ((currentPage - 1) * 25).toString(),
          count: '25',
          savedSearchId,
          trackingParam: `(sessionId:${sessionId})`,
          decorationId: 'com.linkedin.sales.deco.desktop.searchv2.AccountSearchResult-4'
        });
        const apiUrl = `https://www.linkedin.com/sales-api/salesApiAccountSearch?${queryParams.toString()}`;
        const headers = {
          'Csrf-Token': getCsrfToken(),
          'Accept': 'application/json, */*',
          'x-restli-protocol-version': '2.0.0',
          'x-li-lang': 'en_US',
          'x-li-track': '{"clientVersion":"2.0.0","osName":"web","osVersion":"unknown","deviceType":"desktop"}',
          'x-li-page-instance': 'urn:li:page:sales/search',
          'x-source': 'sales-navigator'
        };
        await new Promise(resolve => setTimeout(resolve, 2000));
        const response = await fetch(apiUrl, { method: 'GET', headers, credentials: 'include' });
        if (!response.ok) {
          updateUI({ statusMessage: `HTTP error: ${response.status} on page ${currentPage}` });
          break;
        }
        const data = await response.json();
        console.log('API Response for page', currentPage, ':', data); // Debug log
        
        if (!data?.elements?.length) {
          updateUI({ statusMessage: `⚠️ No accounts on page ${currentPage}` });
          break;
        }

        // Process and enhance account data
        const processedAccounts = [];
        for (const account of data.elements) {
          console.log('Processing account:', account); // Debug log
          console.log('Available account fields:', Object.keys(account)); // Debug log
          
          const companyId = account.entityUrn ? account.entityUrn.split(':').pop() : null;
          let enhancedData = {};
          
          // Temporarily skip enhanced data fetching to debug basic search results
          // TODO: Re-enable enhanced data fetching once we fix basic data extraction
          
          // Fetch enhanced company details if companyId exists
          if (false && companyId) { // Temporarily disabled
            try {
              // Add small delay to avoid rate limiting
              await new Promise(resolve => setTimeout(resolve, 500));
              enhancedData = await fetchCompanyDetails(companyId);
              console.log('Enhanced data for', account.name, ':', enhancedData); // Debug log
              console.log('Available enhanced fields:', Object.keys(enhancedData)); // Debug log
            } catch (error) {
              console.error('Error fetching enhanced data for company:', companyId, error);
              enhancedData = {}; // Ensure we have an empty object
            }
          }

          // Extract location data from multiple possible sources
          let locationData = '';
          let headquartersData = '';
          let websiteData = '';
          let revenueData = '';

          // Location extraction - check multiple possible field names
          locationData = account.location || account.companyLocation || account.primaryLocation || 
                        account.geographicArea || enhancedData.location || enhancedData.companyLocation ||
                        (account.headquarters && (account.headquarters.city || account.headquarters.geographicArea)) ||
                        (enhancedData.headquarters && (enhancedData.headquarters.city || enhancedData.headquarters.geographicArea)) || '';

          // Headquarters extraction
          if (account.headquarters) {
            headquartersData = `${account.headquarters.city || ''}, ${account.headquarters.geographicArea || ''}`.trim().replace(/^,\s*|,\s*$/g, '');
          } else if (enhancedData.headquarters) {
            headquartersData = `${enhancedData.headquarters.city || ''}, ${enhancedData.headquarters.geographicArea || ''}`.trim().replace(/^,\s*|,\s*$/g, '');
          } else if (account.location) {
            headquartersData = account.location;
          }

          // Website extraction - check multiple possible field names
          websiteData = account.website || account.companyUrl || account.url || account.websiteUrl ||
                       enhancedData.website || enhancedData.companyUrl || enhancedData.url || enhancedData.websiteUrl || '';

          // Revenue extraction - check multiple possible field names
          revenueData = account.formattedRevenue || account.revenue || account.revenueRange || account.annualRevenue ||
                       account.revenueDisplay || account.companyRevenue || 
                       enhancedData.formattedRevenue || enhancedData.revenue || enhancedData.revenueRange || 
                       enhancedData.annualRevenue || enhancedData.revenueDisplay || enhancedData.companyRevenue || '';

          console.log('Extracted data:', { locationData, headquartersData, websiteData, revenueData }); // Debug log

          const processedAccount = {
            companyName: account.name || account.companyName || enhancedData.name || '',
            industry: account.industry || enhancedData.industry || '',
            employeeCount: account.employeeCount || enhancedData.employeeCount || account.employeeDisplayCount || '',
            employeeCountRange: account.employeeCountRange || enhancedData.employeeCountRange || '',
            location: locationData,
            headquarters: headquartersData,
            website: websiteData,
            revenue: revenueData,
            description: enhancedData.description || account.description || '',
            linkedinUrl: enhancedData.flagshipCompanyUrl || account.flagshipCompanyUrl || account.companyUrl || enhancedData.companyUrl || '',
            entityUrn: account.entityUrn || '',
            scrapedDate: new Date().toISOString(),
            pageNumber: currentPage
          };
          
          console.log('Processed account:', processedAccount); // Debug log
          processedAccounts.push(processedAccount);
        }

        allAccounts = [...allAccounts, ...data.elements];
        scrapedAccountsData = [...scrapedAccountsData, ...processedAccounts];
        
        const scrapedPageCount = currentPage - startPage + 1;
        const totalPagesToScrape = pageLimit - startPage + 1;
        updateUI({
          statusMessage: `✅ Page ${currentPage}: ${data.elements.length} accounts`,
          progress: (scrapedPageCount / totalPagesToScrape) * 100,
          scrapingPage: currentPage
        });

        if (data.elements.length === 0) break;

        currentPage++;
        if (isScraping && currentPage <= pageLimit) {
          await goToNextPage();
        }
      } catch (error) {
        console.error('Error scraping accounts page:', error);
        updateUI({ statusMessage: `⚠️ Error on page ${currentPage}: ${error.message}` });
        break;
      }
    }
    return allAccounts;
  }

  async function fetchCompanyDetails(companyId) {
    const url = `https://www.linkedin.com/sales-api/salesApiCompanies/${companyId}?decoration=${decoration}`;
    const headers = {
      'Csrf-Token': getCsrfToken(),
      'Accept': 'application/json, */*',
      'x-restli-protocol-version': '2.0.0'
    };
    try {
      const resp = await fetch(url, { credentials: 'include', headers });
      if (!resp.ok) {
        console.warn(`Failed to fetch company details for ${companyId}: ${resp.status}`);
        return {};
      }
      const data = await resp.json();
      console.log(`Company details API response for ${companyId}:`, data); // Debug log
      return data;
    } catch (e) {
      console.error('Error fetching company details:', e);
      return {};
    }
  }

  // CSV Export functionality
  function convertToCSV(data) {
    if (!data || data.length === 0) return '';
    
    const headers = [
      'Company Name',
      'Industry', 
      'Employee Count',
      'Employee Count Range',
      'Location',
      'Headquarters',
      'Website',
      'Revenue',
      'Description',
      'LinkedIn URL',
      'Entity URN',
      'Scraped Date',
      'Page Number'
    ];
    
    const csvRows = [headers.join(',')];
    
    for (const account of data) {
      const row = [
        `"${(account.companyName || '').replace(/"/g, '""')}"`,
        `"${(account.industry || '').replace(/"/g, '""')}"`,
        `"${(account.employeeCount || '').toString().replace(/"/g, '""')}"`,
        `"${(account.employeeCountRange || '').replace(/"/g, '""')}"`,
        `"${(account.location || '').replace(/"/g, '""')}"`,
        `"${(account.headquarters || '').replace(/"/g, '""')}"`,
        `"${(account.website || '').replace(/"/g, '""')}"`,
        `"${(account.revenue || '').replace(/"/g, '""')}"`,
        `"${(account.description || '').replace(/"/g, '""')}"`,
        `"${(account.linkedinUrl || '').replace(/"/g, '""')}"`,
        `"${(account.entityUrn || '').replace(/"/g, '""')}"`,
        `"${(account.scrapedDate || '').replace(/"/g, '""')}"`,
        `"${(account.pageNumber || '').toString().replace(/"/g, '""')}"`
      ];
      csvRows.push(row.join(','));
    }
    
    return csvRows.join('\n');
  }

  function downloadCSV(csvContent, filename) {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function exportAccountsToCSV() {
    if (!scrapedAccountsData || scrapedAccountsData.length === 0) {
      updateUI({ statusMessage: '⚠️ No account data available to export.' });
      return;
    }
    
    const csvContent = convertToCSV(scrapedAccountsData);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `linkedin-accounts-${timestamp}.csv`;
    
    downloadCSV(csvContent, filename);
    updateUI({ statusMessage: `✅ Exported ${scrapedAccountsData.length} accounts to ${filename}` });
  }

  function clearScrapedData() {
    scrapedAccountsData = [];
    chrome.storage.local.remove(['scrapedAccountsData'], () => {
      console.log('Scraped accounts data cleared from storage');
      updateUI({ 
        showExportButton: false,
        statusMessage: 'Scraped data cleared. Ready for new scraping session.'
      });
    });
  }

  // Register message listener immediately
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Content script received message:', message);
    if (message.action === 'openModal') {
      createModal();
      sendResponse({ status: 'modalOpened' });
    }
    return true;
  });
})();