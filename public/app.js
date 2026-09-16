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
const toggleEnableBridge = document.getElementById('bridge-enable-toggle');
const statusBadge = document.getElementById('bridge-status-indicator');
const selectPreset = document.getElementById('preset-selector');
const inputPresetName = document.getElementById('preset-name');
const btnSavePreset = document.getElementById('btn-save-preset');
const btnLoadPreset = document.getElementById('btn-load-preset');

// Entrada Art-Net
const selArtnetInIface = document.getElementById('artnet-in-interface');
const chkArtnetInEnabled = document.getElementById('artnet-in-enabled');
// Entrada sACN
const selSacnInIface = document.getElementById('sacn-in-interface');
const chkSacnInEnabled = document.getElementById('sacn-in-enabled');
const inSacnMcFrom = document.getElementById('sacn-mc-from');
const inSacnMcTo = document.getElementById('sacn-mc-to');
// Unificación
const selMergeSources = document.getElementById('merge-sources');
const selMergePolicy = document.getElementById('merge-policy');
// Salida
const selOutProtocol = document.getElementById('out-protocol');
const selOutInterface = document.getElementById('bridge-out-interface');
const selOutTargetMode = document.getElementById('out-target-mode');
const inputTargetIp = document.getElementById('bridge-target-ip');
const inOutPort = document.getElementById('out-port');
const inOutRate = document.getElementById('out-rate');
const selectUniverseOffset = document.getElementById('bridge-universe-offset');
const inputMutedUniverses = document.getElementById('bridge-muted-universes');
// Estado
const statsText = document.getElementById('bridge-stats-text');
const sourceBadge = document.getElementById('source-badge');
const btnUnified = document.getElementById('btn-unified');
const currentProtocolDisplay = document.getElementById('current-protocol-display');

// View Controls
const btnIntensity = document.getElementById('btn-intensity');
const btnValues = document.getElementById('btn-values');
const btnPause = document.getElementById('btn-pause');

// State
let currentProtocol = 'sACN'; // 'sACN', 'ArtNet' o 'Unified'
let unifiedInfo = {}; // universo -> { winner, present }
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
    [['sACN', btnSacn], ['ArtNet', btnArtnet], ['Unified', btnUnified]].forEach(([name, btn]) => {
        if (!btn) return;
        if (name === proto) btn.classList.add('active');
        else btn.classList.remove('active');
    });
    if (currentProtocolDisplay) currentProtocolDisplay.textContent = proto;
    updateSourceBadge();

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
if (btnUnified) btnUnified.addEventListener('click', () => switchProtocol('Unified'));

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

// Muestra qué fuentes alimentan el universo que estamos mirando
function updateSourceBadge() {
    if (!sourceBadge) return;
    if (currentUniverse === null || currentUniverse === 'all') {
        sourceBadge.textContent = currentProtocol === 'Unified'
            ? 'Unified = Art-Net + sACN mezclados'
            : `Viendo ${currentProtocol}`;
        return;
    }
    const info = unifiedInfo[currentUniverse];
    if (!info) {
        sourceBadge.textContent = `${currentProtocol} · universo ${currentUniverse}`;
        return;
    }
    const flags = [];
    if (info.present.includes('artnet')) flags.push('Art-Net');
    if (info.present.includes('sacn')) flags.push('sACN');
    sourceBadge.textContent = `Universo ${currentUniverse} · fuentes: ${flags.join(' + ') || '—'} · gana: ${info.winner || '—'}`;
}

// --- BRIDGE MODAL LOGIC ---

// Toggle Modal
btnBridgeSettings.addEventListener('click', () => {
    bridgeModal.classList.remove('hidden');
});

btnCloseModal.addEventListener('click', () => {
    bridgeModal.classList.add('hidden');
});

function fillInterfaceSelect(select, { includeAll, includeDefault }) {
    if (!select) return;
    select.innerHTML = '';
    if (includeAll) {
        const all = document.createElement('option');
        all.value = '0.0.0.0';
        all.textContent = '0.0.0.0 (Todas las placas)';
        select.appendChild(all);
    }
    if (includeDefault) {
        const def = document.createElement('option');
        def.value = '';
        def.textContent = 'Default Route (cualquiera)';
        select.appendChild(def);
    }
}

socket.on('network-interfaces', (interfaces) => {
    const outValue = selOutInterface ? selOutInterface.value : '';
    fillInterfaceSelect(selArtnetInIface, { includeAll: true });
    fillInterfaceSelect(selSacnInIface, { includeAll: true });
    fillInterfaceSelect(selOutInterface, { includeDefault: true });

    interfaces.forEach(net => {
        const label = `${net.name} - ${net.address}`;
        [
            [selArtnetInIface, net.address],
            [selSacnInIface, net.address],
            [selOutInterface, net.address],
        ].forEach(([select, value]) => {
            if (!select) return;
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = value === '127.0.0.1' ? `Localhost - ${value}` : label;
            select.appendChild(opt);
        });
    });

    if (selOutInterface && outValue) selOutInterface.value = outValue;
});

// Recibe la configuración activa del servidor y refleja el estado en el panel
socket.on('bridge-config', (config) => {
    const artnetIn = config.artnetIn || { enabled: true, interface: config.inInterface || '0.0.0.0' };
    const sacnIn = config.sacnIn || { enabled: true, interface: config.inInterface || '0.0.0.0', multicastFrom: 1, multicastTo: 100 };
    const merge = config.merge || { policy: 'htp', sources: 'both' };
    const out = config.out || {
        protocol: 'sacn',
        interface: config.outInterface || '',
        targetMode: (String(config.targetIp || '').toLowerCase() === 'multicast') ? 'multicast' : 'unicast',
        targetIp: config.targetIp || '127.0.0.1',
        port: null,
        rate: 30,
    };

    if (selArtnetInIface) selArtnetInIface.value = artnetIn.interface || '0.0.0.0';
    if (chkArtnetInEnabled) chkArtnetInEnabled.checked = artnetIn.enabled !== false;
    if (selSacnInIface) selSacnInIface.value = sacnIn.interface || '0.0.0.0';
    if (chkSacnInEnabled) chkSacnInEnabled.checked = sacnIn.enabled !== false;
    if (inSacnMcFrom) inSacnMcFrom.value = sacnIn.multicastFrom ?? 1;
    if (inSacnMcTo) inSacnMcTo.value = sacnIn.multicastTo ?? 100;

    if (selMergeSources) selMergeSources.value = merge.sources || 'both';
    if (selMergePolicy) selMergePolicy.value = merge.policy || 'htp';

    if (selOutProtocol) selOutProtocol.value = out.protocol || 'sacn';
    if (selOutInterface) selOutInterface.value = out.interface || '';
    if (selOutTargetMode) selOutTargetMode.value = out.targetMode || 'unicast';
    if (inOutPort) inOutPort.value = out.port || '';
    if (inOutRate) inOutRate.value = out.rate || 30;
    if (inputTargetIp) {
        inputTargetIp.value = out.targetIp || '127.0.0.1';
        inputTargetIp.style.display = (out.targetMode === 'unicast') ? 'block' : 'none';
    }

    if (toggleEnableBridge) toggleEnableBridge.checked = !!config.enabled;
    if (selectUniverseOffset) selectUniverseOffset.value = config.universeOffset || 0;
    if (inputMutedUniverses) inputMutedUniverses.value = (config.mutedUniverses || []).join(', ');

    universeOffset = parseInt(config.universeOffset || 0);

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

// Detalle de fuentes por universo (qué entrada está presente y quién gana)
socket.on('unified-info', (info) => {
    unifiedInfo = info || {};
    updateSourceBadge();
});

// Estado del tráfico del bridge
socket.on('bridge-stats', (st) => {
    if (!statsText || !st) return;
    const rec = st.received || {};
    const sent = st.sent || {};
    const bound = st.boundTo || {};
    const lines = [
        `IN  · Art-Net: ${rec.artnet || 0} paquetes  (escuchando ${bound.artnet || '—'})`,
        `IN  · sACN: ${rec.sacn || 0} paquetes  (escuchando ${bound.sacn || '—'}${st.multicastGroups ? `, ${st.multicastGroups} grupos multicast` : ''})`,
        `OUT · Art-Net: ${sent.artnet || 0}  ·  sACN: ${sent.sacn || 0}`,
    ];
    if (st.lastSendError) lines.push(`⚠ Último error de envío: ${st.lastSendError}`);
    statsText.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
});

// Muestra/oculta el campo de IP según el modo de destino
if (selOutTargetMode) {
    selOutTargetMode.addEventListener('change', () => {
        if (inputTargetIp) inputTargetIp.style.display = (selOutTargetMode.value === 'unicast') ? 'block' : 'none';
    });
}

// Arma el objeto de configuración desde el panel
function readBridgeConfig() {
    const mutedArr = inputMutedUniverses.value.split(',')
        .map(v => v.trim())
        .filter(v => v !== '')
        .map(v => parseInt(v))
        .filter(v => !isNaN(v));

    const portRaw = inOutPort ? inOutPort.value.trim() : '';

    return {
        enabled: toggleEnableBridge.checked,
        artnetIn: {
            enabled: chkArtnetInEnabled ? chkArtnetInEnabled.checked : true,
            interface: selArtnetInIface ? selArtnetInIface.value : '0.0.0.0',
        },
        sacnIn: {
            enabled: chkSacnInEnabled ? chkSacnInEnabled.checked : true,
            interface: selSacnInIface ? selSacnInIface.value : '0.0.0.0',
            multicastFrom: parseInt(inSacnMcFrom ? inSacnMcFrom.value : 1) || 0,
            multicastTo: parseInt(inSacnMcTo ? inSacnMcTo.value : 100) || 0,
            joinMulticast: true,
        },
        merge: {
            policy: selMergePolicy ? selMergePolicy.value : 'htp',
            sources: selMergeSources ? selMergeSources.value : 'both',
        },
        out: {
            protocol: selOutProtocol ? selOutProtocol.value : 'sacn',
            interface: selOutInterface ? selOutInterface.value : '',
            targetMode: selOutTargetMode ? selOutTargetMode.value : 'unicast',
            targetIp: inputTargetIp ? inputTargetIp.value.trim() : '127.0.0.1',
            port: portRaw === '' ? null : parseInt(portRaw),
            rate: parseInt(inOutRate ? inOutRate.value : 30) || 30,
        },
        universeOffset: parseInt(selectUniverseOffset.value) || 0,
        mutedUniverses: mutedArr,
    };
}

btnSaveBridge.addEventListener('click', () => {
    socket.emit('update-bridge-config', readBridgeConfig());
    bridgeModal.classList.add('hidden');
});

// Deep-link: http://localhost:3000/#bridge abre el panel directamente
if (location.hash === '#bridge') {
    bridgeModal.classList.remove('hidden');
}

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
    if (!name) return alert('Poné un nombre para el preset');
    socket.emit('save-preset', { name: name, config: readBridgeConfig() });
    inputPresetName.value = '';
});

btnLoadPreset.addEventListener('click', () => {
    const name = selectPreset.value;
    if (name) {
        socket.emit('load-preset', name);
    }
});
