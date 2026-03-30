/* ========================================
   CardScan AI — Main Application Logic
   ======================================== */

const isLocal = window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168');
const API_BASE = isLocal ? `http://${window.location.hostname}:5000` : '';

// ── DOM Elements ──
const cameraBtn = document.getElementById('cameraBtn');
const uploadInput = document.getElementById('uploadInput');

const rootApp = document.querySelector('.app-container');
const scanSection = document.getElementById('scanSection');
const processingSection = document.getElementById('processingSection');
const resultsSection = document.getElementById('resultsSection');
const cameraSection = document.getElementById('cameraSection');

const cameraFeed = document.getElementById('cameraFeed');
const closeCameraBtn = document.getElementById('closeCameraBtn');
const shutterBtn = document.getElementById('shutterBtn');
const switchCameraBtn = document.getElementById('switchCameraBtn');

const previewImage = document.getElementById('previewImage');
const resultPreview = document.getElementById('resultPreview');

const stepOcr = document.getElementById('stepOcr');
const stepAi = document.getElementById('stepAi');
const stepDone = document.getElementById('stepDone');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');

const entityCards = document.getElementById('entityCards');
const addContactBtn = document.getElementById('addContactBtn');
const copyAllBtn = document.getElementById('copyAllBtn');
const scanAgainBtn = document.getElementById('scanAgainBtn');

const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toastMessage');

// ── State ──
let extractedEntities = {};
let currentImageSrc = '';
let mediaStream = null;
let usingFrontCamera = false;

// ── Entity Config ──
const ENTITY_CONFIG = {
    NAME:  { label: 'Name',         icon: '👤', cssClass: 'name',  placeholder: 'Full name' },
    ORG:   { label: 'Organization', icon: '🏢', cssClass: 'org',   placeholder: 'Company name' },
    DES:   { label: 'Designation',  icon: '💼', cssClass: 'des',   placeholder: 'Job title' },
    PHONE: { label: 'Phone',        icon: '📱', cssClass: 'phone', placeholder: 'Phone number' },
    EMAIL: { label: 'Email',        icon: '✉️', cssClass: 'email', placeholder: 'Email address' },
    WEB:   { label: 'Website',      icon: '🌐', cssClass: 'web',   placeholder: 'Website URL' },
};

// ── Init ──
function init() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    setupEventListeners();
}

// ── Event Listeners ──
function setupEventListeners() {
    cameraBtn.addEventListener('click', openCamera);
    closeCameraBtn.addEventListener('click', closeCamera);
    shutterBtn.addEventListener('click', capturePhoto);
    switchCameraBtn.addEventListener('click', () => {
        usingFrontCamera = !usingFrontCamera;
        startCameraStream();
    });

    uploadInput.addEventListener('change', handleImageSelect);
    scanAgainBtn.addEventListener('click', resetToScan);
    addContactBtn.addEventListener('click', addToContacts);
    copyAllBtn.addEventListener('click', copyAllDetails);
}

// ── Camera Implementation ──
async function openCamera() {
    scanSection.classList.add('hidden');
    cameraSection.classList.remove('hidden');
    await startCameraStream();
}

function closeCamera() {
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }
    cameraSection.classList.add('hidden');
    scanSection.classList.remove('hidden');
}

async function startCameraStream() {
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
    }

    const constraints = {
        video: {
            facingMode: usingFrontCamera ? 'user' : 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 }
        }
    };

    try {
        mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        cameraFeed.srcObject = mediaStream;
    } catch (err) {
        console.error('Camera error:', err);
        showToast('Unable to access camera. Please check permissions.');
        closeCamera();
    }
}

function capturePhoto() {
    if (!mediaStream) return;
    
    // Add brief flash effect
    cameraFeed.style.opacity = '0.3';
    setTimeout(() => { cameraFeed.style.opacity = '1'; }, 100);

    const canvas = document.createElement('canvas');
    let width = cameraFeed.videoWidth;
    let height = cameraFeed.videoHeight;
    
    // Scale down to max 1600px dimension
    const maxDim = 1600;
    if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width *= ratio;
        height *= ratio;
    }

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(cameraFeed, 0, 0, canvas.width, canvas.height);
    
    // Compress heavily (0.7 quality) to keep JSON payload under 3MB
    currentImageSrc = canvas.toDataURL('image/jpeg', 0.7);
    
    previewImage.src = currentImageSrc;
    resultPreview.src = currentImageSrc;
    
    // Stop camera and start processing
    closeCamera();
    startProcessing();
}

// ── Image Handling ──
function handleImageSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;
            
            // Scale down to max 1600px dimension
            const maxDim = 1600;
            if (width > maxDim || height > maxDim) {
                const ratio = Math.min(maxDim / width, maxDim / height);
                width *= ratio;
                height *= ratio;
            }

            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            
            // Compress heavily (0.7 quality) to keep JSON payload small
            currentImageSrc = canvas.toDataURL('image/jpeg', 0.7);
            previewImage.src = currentImageSrc;
            resultPreview.src = currentImageSrc;
            startProcessing();
        };
        img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
}

// ── Processing Pipeline (single backend call) ──
async function startProcessing() {
    showSection('processing');
    resetSteps();

    // Animate progress while server processes
    setStepActive('ocr');
    let progress = 0;
    const progressInterval = setInterval(() => {
        progress = Math.min(progress + Math.random() * 5, 85);
        progressFill.style.width = progress + '%';
        progressText.textContent = Math.round(progress) + '%';
    }, 400);

    try {
        const response = await fetch(`${API_BASE}/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: currentImageSrc })
        });

        clearInterval(progressInterval);

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `Server error (${response.status})`);
        }

        const data = await response.json();

        // Mark steps complete
        progressFill.style.width = '100%';
        progressText.textContent = '100%';
        setStepDone('ocr');
        setStepDone('ai');
        setStepDone('done');

        extractedEntities = data.entities || {};

        await sleep(400);
        showResults();
    } catch (err) {
        clearInterval(progressInterval);
        console.error('Processing error:', err);

        if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
            showToast('Server not running. Start it with: python server.py');
        } else {
            showToast(err.message || 'Something went wrong. Please try again.');
        }
        resetToScan();
    }
}

// ── Results Display ──
function showResults() {
    showSection('results');
    renderEntityCards();
}

function renderEntityCards() {
    entityCards.innerHTML = '';

    for (const [key, config] of Object.entries(ENTITY_CONFIG)) {
        const value = extractedEntities[key] || '';
        const card = document.createElement('div');
        card.className = 'entity-card';
        card.innerHTML = `
            <div class="entity-icon ${config.cssClass}">${config.icon}</div>
            <div class="entity-content">
                <div class="entity-label">${config.label}</div>
                <input class="entity-value" 
                    type="text" 
                    value="${escapeHtml(value)}" 
                    placeholder="${config.placeholder}"
                    data-entity="${key}">
            </div>
        `;
        entityCards.appendChild(card);
    }

    entityCards.querySelectorAll('.entity-value').forEach(input => {
        input.addEventListener('change', (e) => {
            extractedEntities[e.target.dataset.entity] = e.target.value;
        });
    });
}

// ── Android Contact Integration (vCard) ──
async function addToContacts() {
    const name = extractedEntities.NAME || 'Unknown';
    const org = extractedEntities.ORG || '';
    const title = extractedEntities.DES || '';
    const phones = (extractedEntities.PHONE || '').split(',').map(p => p.trim()).filter(Boolean);
    const emails = (extractedEntities.EMAIL || '').split(',').map(e => e.trim()).filter(Boolean);
    const webs = (extractedEntities.WEB || '').split(',').map(w => w.trim()).filter(Boolean);

    const nameParts = name.split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    let vcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${name}`,
        `N:${lastName};${firstName};;;`,
    ];

    if (org) vcard.push(`ORG:${org}`);
    if (title) vcard.push(`TITLE:${title}`);
    phones.forEach(phone => vcard.push(`TEL;TYPE=CELL:${phone}`));
    emails.forEach(email => vcard.push(`EMAIL;TYPE=INTERNET:${email}`));
    webs.forEach(web => {
        let url = web;
        if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
        vcard.push(`URL:${url}`);
    });
    vcard.push('END:VCARD');

    const vcardContent = vcard.join('\r\n');
    const fileName = `${name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_')}.vcf`;
    
    // Convert to File for Web Share API
    const file = new File([vcardContent], fileName, { type: 'text/vcard' });
    
    // Try Native Android Contacts app via Web Share API
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({
                files: [file],
                title: 'Save Contact',
                text: `Contact details for ${name}`
            });
            showToast('Contact sent to native app ✓');
            return;
        } catch (err) {
            console.warn('Share API failed or cancelled:', err);
            // Fallthrough to download
        }
    }

    // Fallback: standard web download
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('Contact file downloaded — open it to add to your contacts!');
}

// ── Copy All ──
function copyAllDetails() {
    const lines = [];
    for (const [key, config] of Object.entries(ENTITY_CONFIG)) {
        const val = extractedEntities[key];
        if (val) lines.push(`${config.label}: ${val}`);
    }

    const text = lines.join('\n');
    navigator.clipboard.writeText(text).then(() => {
        showToast('Contact details copied ✓');
    }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Contact details copied ✓');
    });
}

// ── UI Helpers ──
function showSection(section) {
    scanSection.classList.add('hidden');
    processingSection.classList.add('hidden');
    resultsSection.classList.add('hidden');

    switch (section) {
        case 'scan': scanSection.classList.remove('hidden'); break;
        case 'processing': processingSection.classList.remove('hidden'); break;
        case 'results': resultsSection.classList.remove('hidden'); break;
    }
}

function resetToScan() {
    extractedEntities = {};
    currentImageSrc = '';
    showSection('scan');
}

function resetSteps() {
    [stepOcr, stepAi, stepDone].forEach(step => {
        step.classList.remove('active', 'done');
    });
    progressFill.style.width = '0%';
    progressText.textContent = '0%';
    stepOcr.querySelector('.step-indicator').innerHTML = '<div class="step-dot"></div>';
    stepAi.querySelector('.step-indicator').innerHTML = '<div class="step-dot"></div>';
    stepDone.querySelector('.step-indicator').innerHTML = '<div class="step-dot"></div>';
}

function setStepActive(step) {
    const el = step === 'ocr' ? stepOcr : step === 'ai' ? stepAi : stepDone;
    el.classList.add('active');
    el.querySelector('.step-indicator').innerHTML = '<div class="spinner"></div>';
}

function setStepDone(step) {
    const el = step === 'ocr' ? stepOcr : step === 'ai' ? stepAi : stepDone;
    el.classList.remove('active');
    el.classList.add('done');
    el.querySelector('.step-indicator').innerHTML = '<div class="step-dot"></div>';
}

function showToast(message, duration = 3000) {
    toastMessage.textContent = message;
    toast.classList.remove('hidden');
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.classList.add('hidden'), 300);
    }, duration);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML.replace(/"/g, '&quot;');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Start ──
init();
