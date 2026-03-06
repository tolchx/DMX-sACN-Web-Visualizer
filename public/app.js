const socket = io();

// DOM Elements
const connectionDot = document.getElementById('connection-dot');
const connectionText = document.getElementById('connection-text');
const universeSelector = document.getElementById('universe-selector');
const activeGrid = document.getElementById('active-universes-grid');
const activeCount = document.getElementById('active-count');
const currentUniverseDisplay = document.getElementById('current-universe-display');
const gridsContainer = document.getElementById('grids-container');
const fpsCounter = document.getElementById('fps-counter');
const minimapContainer = document.getElementById('minimap-container');
const btnSacn = document.getElementById('btn-sacn');
const btnArtnet = document.getElementById('btn-artnet');

// Bridge Modal DOM Elements
const btnBridgeSettings = document.getElementById('btn-bridge-settings');
const bridgeModal = document.getElementById('bridge-modal');
const btnCloseModal = document.getElementById('close-modal');
const btnSaveBridge = document.getElementById('btn-save-bridge');
const selectOutInterface = document.getElementById('bridge-out-interface');
const inputTargetIp = document.getElementById('bridge-target-ip');
const toggleEnableBridge = document.getElementById('bridge-enable-toggle');
const statusBadge = document.getElementById('bridge-status-indicator');
const selectInInterface = document.getElementById('bridge-in-interface');
const selectUniverseOffset = document.getElementById('bridge-universe-offset');
const inputMutedUniverses = document.getElementById('bridge-muted-universes');
const selectPreset = document.getElementById('preset-selector');
const inputPresetName = document.getElementById('preset-name');
const btnSavePreset = document.getElementById('btn-save-preset');
const btnLoadPreset = document.getElementById('btn-load-preset');

// View Controls
const btnIntensity = document.getElementById('btn-intensity');
const btnValues = document.getElementById('btn-values');
const btnPause = document.getElementById('btn-pause');

// State
let currentProtocol = 'sACN'; // 'sACN' or 'ArtNet'
let currentUniverse = null; // can be number or 'all'
let activeUniverses = { sACN: [], ArtNet: [] };
let frames = 0;
let lastFpsTime = performance.now();
let isPaused = false;
let viewMode = 'intensity'; // 'intensity' or 'values'
let universeOffset = 0;

// High Performance Data Model
const universeData = new Map(); // "sACN-1" -> Uint8Array(512)
const universeDirty = new Set(); // "sACN-1" ids that need re-rendering

// DOM Cache
const gridsCache = new Map(); // "sACN-1" -> channels[] HTML Elements
const minimapCache = new Map(); // "sACN-1" -> { wrapper, ctx } (Canvas Context)

function createGrid(universe) {
    const wrapper = document.createElement('div');
    wrapper.className = 'universe-grid-wrapper';

    const title = document.createElement('h3');
    title.textContent = `Universe ${universe}`;
    title.className = 'universe-grid-title';
    wrapper.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'dmx-grid';

    const channels = [];
    // Populate quickly
    let html = '';
    for (let i = 1; i <= 512; i++) {
        html += `<div class="dmx-channel">${i}</div>`;
    }
    grid.innerHTML = html;

    const children = grid.children;
    for (let i = 0; i < 512; i++) {
        const el = children[i];
        el.__val = 0; // fast expando property for diffing
        channels.push(el);
    }

    wrapper.appendChild(grid);
    return { wrapper, channels, title };
}

function renderGrids() {
    gridsContainer.innerHTML = '';
    gridsCache.clear();

    const idList = activeUniverses[currentProtocol] || [];

    if (currentUniverse === 'all') {
        currentUniverseDisplay.textContent = 'All';
        idList.forEach(uni => {
            const gridObj = createGrid(uni);
            gridsContainer.appendChild(gridObj.wrapper);
            const key = `${currentProtocol}-${uni}`;
            gridsCache.set(key, gridObj.channels);
            universeDirty.add(key); // Force immediate paint
        });
    } else if (currentUniverse !== null) {
        currentUniverseDisplay.textContent = currentUniverse;
        const gridObj = createGrid(currentUniverse);
        gridObj.title.style.display = 'none'; // Hide inner title since header has it
        gridsContainer.appendChild(gridObj.wrapper);
        const key = `${currentProtocol}-${currentUniverse}`;
        gridsCache.set(key, gridObj.channels);
        universeDirty.add(key); // Force immediate paint
    }
}

// Interactivity: Setup Select Dropdown & Click events
universeSelector.addEventListener('change', (e) => {
    const val = e.target.value;
    switchUniverse(val === 'all' ? 'all' : parseInt(val));
});

function switchProtocol(proto) {
    if (currentProtocol === proto) return;
    currentProtocol = proto;

    // update buttons style
    if (proto === 'sACN') {
        btnSacn.classList.add('active');
        btnArtnet.classList.remove('active');
    } else {
        btnArtnet.classList.add('active');
        btnSacn.classList.remove('active');
    }

    // Fallback safe state
    currentUniverse = null;

    // Re-join server side routing
    socket.emit('join-universe', { protocol: currentProtocol, universeId: 'all' });

    const activeForProto = activeUniverses[currentProtocol] || [];
    if (activeForProto.length > 0) {
        switchUniverse(activeForProto[0]);
    } else {
        updateSelector();
        renderActiveUniverses();
        renderMinimap();
        renderGrids();
    }
}

btnSacn.addEventListener('click', () => switchProtocol('sACN'));
btnArtnet.addEventListener('click', () => switchProtocol('ArtNet'));

function switchUniverse(universeId) {
    currentUniverse = universeId;
    universeSelector.value = universeId;

    // Notify server to join room for specific active data routing
    socket.emit('join-universe', { protocol: currentProtocol, universeId: universeId });

    // Rebuild UI
    renderGrids();
    renderActiveUniverses();

    // Update highlighted minimap items
    minimapCache.forEach((obj, key) => {
        const parts = key.split('-');
        const proto = parts[0];
        const uni = parts[1] === 'all' ? 'all' : parseInt(parts[1]);

        if (proto === currentProtocol && (uni === currentUniverse || currentUniverse === 'all')) {
            obj.wrapper.classList.add('selected');
        } else {
            obj.wrapper.classList.remove('selected');
        }
    });
}

// View Mode Logic
btnIntensity.addEventListener('click', () => {
    viewMode = 'intensity';
    btnIntensity.classList.add('active');
    btnValues.classList.remove('active');
    forceRepaintAll();
});

btnValues.addEventListener('click', () => {
    viewMode = 'values';
    btnValues.classList.add('active');
    btnIntensity.classList.remove('active');
    forceRepaintAll();
});

btnPause.addEventListener('click', () => {
    isPaused = !isPaused;
    if (isPaused) {
        btnPause.classList.add('active');
        btnPause.textContent = 'Resume';
    } else {
        btnPause.classList.remove('active');
        btnPause.textContent = 'Pause';
    }
});

function forceRepaintAll() {
    universeData.forEach((_, key) => universeDirty.add(key));
}

// Helper to calculate color based on intensity (Green scale)
function getIntensityColor(value) {
    if (value === 0) return 'var(--dmx-inactive)';
    const MathAlpha = (value / 255.0) * 0.9 + 0.1;
    return `rgba(0, 255, 136, ${MathAlpha})`;
}

// Draw a single 32x16 minimap super fast directly onto an ImageData buffer
function drawMiniCanvas(ctx, dataArr) {
    const imgData = ctx.createImageData(32, 16);
    const buf = new Uint32Array(imgData.data.buffer);

    for (let i = 0; i < 512; i++) {
        const val = dataArr[i];
        if (val === 0) {
            buf[i] = 0xff111111; // Dark #111 -> ABGR order
        } else {
            const opacity = (val / 255.0) * 0.9 + 0.1;
            const r = 0;
            const g = Math.floor(255 * opacity);
            const b = Math.floor(136 * opacity);
            buf[i] = (255 << 24) | (b << 16) | (g << 8) | r; // ABGR encoding
        }
    }
    ctx.putImageData(imgData, 0, 0);
}

// ---- GAME LOOP FOR RENDERING ----
function renderLoop() {
    if (!isPaused) {
        universeDirty.forEach(key => {
            const dataMap = universeData.get(key);
            if (!dataMap) return;

            // 1. Update Main Grid (only DOM elements that actually changed)
            const mainChannels = gridsCache.get(key);
            if (mainChannels) {
                for (let i = 0; i < 512; i++) {
                    const val = dataMap[i];
                    const el = mainChannels[i];

                    // Always update text if in values mode
                    if (viewMode === 'values') {
                        if (el.__textVal !== val) {
                            el.textContent = val > 0 ? val : i + 1;
                            el.__textVal = val;
                        }
                    } else {
                        if (el.__textVal !== undefined) {
                            el.textContent = i + 1;
                            el.__textVal = undefined;
                        }
                    }

                    // Only touch DOM styles if changed!
                    if (el.__val !== val) {
                        el.__val = val;
                        el.style.backgroundColor = getIntensityColor(val);
                        if (viewMode === 'values' && val > 0) {
                            el.style.color = 'rgba(0,0,0,0.8)';
                            el.style.fontWeight = 'bold';
                        } else if (val > 0) {
                            el.style.color = 'rgba(0,0,0,0.5)';
                            el.style.fontWeight = 'normal';
                        } else {
                            el.style.color = 'rgba(255,255,255,0.3)';
                            el.style.fontWeight = 'normal';
                        }
                    }
                }
            }

            // 2. Update Minimap Grid (Via high perf Canvas pixel buffer)
            const mini = minimapCache.get(key);
            if (mini) {
                drawMiniCanvas(mini.ctx, dataMap);
            }
        });

        universeDirty.clear(); // Clear jobs for this frame
    }

    // update FPS
    frames++;
    const now = performance.now();
    if (now - lastFpsTime >= 1000) {
        fpsCounter.textContent = frames;
        frames = 0;
        lastFpsTime = now;
    }

    requestAnimationFrame(renderLoop);
}

// Start The Game Loop
requestAnimationFrame(renderLoop);


// WebSockets Events
socket.on('connect', () => {
    connectionDot.classList.remove('disconnected');
    connectionDot.classList.add('connected');
    connectionText.textContent = 'Connected';
    socket.emit('join-universe', { protocol: currentProtocol, universeId: 'all' });

    // Request IPs and presets
    socket.emit('get-network-interfaces');
    socket.emit('get-presets');
});

socket.on('disconnect', () => {
    connectionDot.classList.add('disconnected');
    connectionDot.classList.remove('connected');
    connectionText.textContent = 'Disconnected';
});

socket.on('active-universes', (payloadObj) => {
    // Both protocols return in payload
    if (JSON.stringify(payloadObj) !== JSON.stringify(activeUniverses)) {
        activeUniverses = payloadObj;

        updateSelector();
        renderActiveUniverses();
        renderMinimap();

        const activeList = activeUniverses[currentProtocol] || [];
        activeCount.textContent = activeList.length;

        if (currentUniverse === null && activeList.length > 0) {
            switchUniverse(activeList[0]);
        } else if (currentUniverse === 'all') {
            renderGrids(); // active list changed, rebuild DOM grids
        }
    }
});

function updateSelector() {
    universeSelector.innerHTML = '<option value="" disabled>Select a Universe</option>';

    const activeList = activeUniverses[currentProtocol] || [];

    if (activeList.length === 0) {
        universeSelector.innerHTML = '<option value="" disabled selected>Waiting for data...</option>';
        return;
    }

    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = 'All Universes';
    if (currentUniverse === 'all') allOpt.selected = true;
    universeSelector.appendChild(allOpt);

    activeList.forEach(uni => {
        const option = document.createElement('option');
        option.value = uni;
        option.textContent = `Universe ${uni + universeOffset}`;
        if (currentUniverse === uni) option.selected = true;
        universeSelector.appendChild(option);
    });
}

function renderActiveUniverses() {
    activeGrid.innerHTML = '';
    const activeList = activeUniverses[currentProtocol] || [];

    if (activeList.length > 0) {
        const allPill = document.createElement('div');
        allPill.className = `universe-pill active ${'all' === currentUniverse ? 'selected' : ''}`;
        allPill.textContent = `ALL`;
        allPill.addEventListener('click', () => switchUniverse('all'));
        activeGrid.appendChild(allPill);
    }

    activeList.forEach(uni => {
        const pill = document.createElement('div');
        pill.className = `universe-pill active ${uni === currentUniverse ? 'selected' : ''}`;
        pill.textContent = `U${uni + universeOffset}`;
        pill.addEventListener('click', () => switchUniverse(uni));
        activeGrid.appendChild(pill);
    });
}

function renderMinimap() {
    minimapContainer.innerHTML = '';
    // Optional: Only clear for current protocol to save memory, or clear all
    minimapCache.clear();

    const activeList = activeUniverses[currentProtocol] || [];

    activeList.forEach(uni => {
        const wrapper = document.createElement('div');
        wrapper.className = `mini-grid-wrapper ${uni === currentUniverse || currentUniverse === 'all' ? 'selected' : ''}`;
        wrapper.addEventListener('click', () => switchUniverse(uni));

        const label = document.createElement('div');
        label.className = 'mini-grid-label';
        label.textContent = uni + universeOffset;
        wrapper.appendChild(label);

        const miniGrid = document.createElement('canvas');
        miniGrid.width = 32;
        miniGrid.height = 16;
        miniGrid.className = 'mini-dmx-canvas';

        const ctx = miniGrid.getContext('2d', { alpha: false });

        wrapper.appendChild(miniGrid);
        minimapContainer.appendChild(wrapper);

        const key = `${currentProtocol}-${uni}`;
        minimapCache.set(key, { wrapper, ctx });

        // Force an initial draw in the background
        universeDirty.add(key);
    });
}

// Receive actual array and queue for rendering
socket.on('dmx-data', (payload) => {
    // Expected format: { protocol: 'sACN' | 'ArtNet', universe: 1, data: [...] }
    const protocolIn = payload.protocol || 'sACN'; // Fallback for safety
    if (protocolIn !== currentProtocol) return; // Only process what we are watching

    const uni = payload.universe;
    const key = `${currentProtocol}-${uni}`;

    let dataMap = universeData.get(key);
    if (!dataMap) {
        dataMap = new Uint8Array(512);
        universeData.set(key, dataMap);
    }

    // Check if we need to update anything (Diffing!)
    const incoming = payload.data;
    let isDirty = false;
    for (let i = 0; i < 512; i++) {
        if (dataMap[i] !== incoming[i]) {
            dataMap[i] = incoming[i];
            isDirty = true;
        }
    }

    // Only flag for render if a value ACTUALLY changed this frame
    if (isDirty) {
        universeDirty.add(key);
    }
});

// --- BRIDGE MODAL LOGIC ---

// Toggle Modal
btnBridgeSettings.addEventListener('click', () => {
    bridgeModal.classList.remove('hidden');
});

btnCloseModal.addEventListener('click', () => {
    bridgeModal.classList.add('hidden');
});

socket.on('network-interfaces', (interfaces) => {
    // Keep the "Default Route" option
    selectOutInterface.innerHTML = '<option value="">Default Route (Any IP)</option>';
    selectInInterface.innerHTML = '<option value="0.0.0.0">0.0.0.0 (All Interfaces)</option>';

    interfaces.forEach(net => {
        const optOut = document.createElement('option');
        optOut.value = net.address;
        optOut.textContent = `${net.name} - ${net.address}`;
        selectOutInterface.appendChild(optOut);

        const optIn = document.createElement('option');
        optIn.value = net.address;
        optIn.textContent = `${net.name} - ${net.address}`;
        selectInInterface.appendChild(optIn);
    });
});

// Receive active bridge config from server
socket.on('bridge-config', (config) => {
    selectInInterface.value = config.inInterface || '0.0.0.0';
    selectOutInterface.value = config.outInterface || '';
    inputTargetIp.value = config.targetIp || '127.0.0.1';
    toggleEnableBridge.checked = config.enabled;
    selectUniverseOffset.value = config.universeOffset || 0;
    inputMutedUniverses.value = (config.mutedUniverses || []).join(', ');

    universeOffset = parseInt(config.universeOffset || 0);

    // Refresh UI to show new offset
    updateSelector();
    renderActiveUniverses();
    renderMinimap();

    if (config.enabled) {
        statusBadge.textContent = 'BRIDGE ON';
        statusBadge.classList.replace('off', 'on');
    } else {
        statusBadge.textContent = 'BRIDGE OFF';
        statusBadge.classList.replace('on', 'off');
    }
});

// Save and apply bridge settings
btnSaveBridge.addEventListener('click', () => {
    // parse muted universes correctly
    const mutedStr = inputMutedUniverses.value;
    const mutedArr = mutedStr.split(',')
        .map(v => v.trim())
        .filter(v => v !== '')
        .map(v => parseInt(v))
        .filter(v => !isNaN(v));

    const newConfig = {
        enabled: toggleEnableBridge.checked,
        inInterface: selectInInterface.value,
        outInterface: selectOutInterface.value,
        targetIp: inputTargetIp.value.trim(),
        universeOffset: parseInt(selectUniverseOffset.value),
        mutedUniverses: mutedArr
    };

    socket.emit('update-bridge-config', newConfig);
    bridgeModal.classList.add('hidden');
});

// --- PRESETS LOGIC ---
socket.on('presets-list', (presets) => {
    selectPreset.innerHTML = '<option value="" disabled selected>Select a preset...</option>';
    presets.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        selectPreset.appendChild(opt);
    });
});

btnSavePreset.addEventListener('click', () => {
    const name = inputPresetName.value.trim();
    if (!name) return alert("Please enter a preset name");

    const mutedStr = inputMutedUniverses.value;
    const mutedArr = mutedStr.split(',')
        .map(v => v.trim())
        .filter(v => v !== '')
        .map(v => parseInt(v))
        .filter(v => !isNaN(v));

    const configToSave = {
        enabled: toggleEnableBridge.checked,
        inInterface: selectInInterface.value,
        outInterface: selectOutInterface.value,
        targetIp: inputTargetIp.value.trim(),
        universeOffset: parseInt(selectUniverseOffset.value),
        mutedUniverses: mutedArr
    };

    socket.emit('save-preset', { name: name, config: configToSave });
    inputPresetName.value = '';
});

btnLoadPreset.addEventListener('click', () => {
    const name = selectPreset.value;
    if (name) {
        socket.emit('load-preset', name);
    }
});
