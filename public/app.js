const socket = io();

// ---------------------------------------------------------------- DOM Elements
const connectionDot = document.getElementById('connection-dot');
const connectionText = document.getElementById('connection-text');
const universeSelector = document.getElementById('universe-selector');
const activeGrid = document.getElementById('active-universes-grid');
const activeCount = document.getElementById('active-count');
const currentUniverseDisplay = document.getElementById('current-universe-display');
const gridsContainer = document.getElementById('grids-container');
const fpsCounter = document.getElementById('fps-counter');
const minimapContainer = document.getElementById('minimap-container');
const btnIn1 = document.getElementById('btn-in1');
const btnIn2 = document.getElementById('btn-in2');
const btnUnified = document.getElementById('btn-unified');
const currentProtocolDisplay = document.getElementById('current-protocol-display');

// Menú del bridge
const btnBridgeSettings = document.getElementById('btn-bridge-settings');
const bridgeModal = document.getElementById('bridge-modal');
const btnCloseModal = document.getElementById('close-modal');
const btnSaveBridge = document.getElementById('btn-save-bridge');
const statusBadge = document.getElementById('bridge-status-indicator');
const toggleEnableRoot = document.getElementById('bridge-enable-root');
const statsText = document.getElementById('bridge-stats-text');
const sourceBadge = document.getElementById('source-badge');
const selectPreset = document.getElementById('preset-selector');
const inputPresetName = document.getElementById('preset-name');
const btnSavePreset = document.getElementById('btn-save-preset');
const btnLoadPreset = document.getElementById('btn-load-preset');

// Entradas genéricas (1 y 2): mismo set de controles
const INPUTS = [0, 1].map((i) => {
    const n = i + 1;
    return {
        index: i,
        protocol: document.getElementById(`in${n}-protocol`),
        iface: document.getElementById(`in${n}-interface`),
        enabled: document.getElementById(`in${n}-enabled`),
        mcFrom: document.getElementById(`in${n}-mc-from`),
        mcTo: document.getElementById(`in${n}-mc-to`),
        mcWrap: document.getElementById(`in${n}-mc-wrap`),
        muted: document.getElementById(`in${n}-muted`),
        chips: document.getElementById(`in${n}-chips`),
        dot: document.getElementById(`dot-in${n}`),
        summary: document.getElementById(`in${n}-summary`),
    };
});

// Unificación y salida
const selMergeSources = document.getElementById('merge-sources');
const selOutProtocol = document.getElementById('out-protocol');
const selOutInterface = document.getElementById('bridge-out-interface');
const selOutTargetMode = document.getElementById('out-target-mode');
const inputTargetIp = document.getElementById('bridge-target-ip');
const inOutPort = document.getElementById('out-port');
const inOutRate = document.getElementById('out-rate');
const selectUniverseOffset = document.getElementById('bridge-universe-offset');

// View controls
const btnIntensity = document.getElementById('btn-intensity');
const btnValues = document.getElementById('btn-values');
const btnPause = document.getElementById('btn-pause');

// ---------------------------------------------------------------------- Estado
let currentProtocol = 'input1'; // 'input1' | 'input2' | 'Unified'
let currentUniverse = null;
let activeUniverses = { input1: [], input2: [], Unified: [] };
let unifiedInfo = {};
let bridgeConfig = null;
let frames = 0;
let lastFpsTime = performance.now();
let isPaused = false;
let viewMode = 'intensity';
let universeOffset = 0;

const PROTOCOL_LABEL = { input1: 'Entrada 1', input2: 'Entrada 2', Unified: 'Unified' };
const PROTOCOL_SHORT = { artnet: 'Art-Net', sacn: 'sACN' };

// Modelo de datos de alta performance
const universeData = new Map(); // "input1-1" -> Uint8Array(512)
const universeDirty = new Set();
const gridsCache = new Map();
const minimapCache = new Map();

// ------------------------------------------------------------------ Grilla DMX
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
    let html = '';
    for (let i = 1; i <= 512; i++) {
        html += `<div class="dmx-channel">${i}</div>`;
    }
    grid.innerHTML = html;

    const children = grid.children;
    for (let i = 0; i < 512; i++) {
        const el = children[i];
        el.__val = 0;
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
            universeDirty.add(key);
        });
    } else if (currentUniverse !== null) {
        currentUniverseDisplay.textContent = currentUniverse;
        const gridObj = createGrid(currentUniverse);
        gridObj.title.style.display = 'none';
        gridsContainer.appendChild(gridObj.wrapper);
        const key = `${currentProtocol}-${currentUniverse}`;
        gridsCache.set(key, gridObj.channels);
        universeDirty.add(key);
    }
}

universeSelector.addEventListener('change', (e) => {
    const val = e.target.value;
    switchUniverse(val === 'all' ? 'all' : parseInt(val));
});

function switchProtocol(proto) {
    if (currentProtocol === proto) return;
    currentProtocol = proto;

    [['input1', btnIn1], ['input2', btnIn2], ['Unified', btnUnified]].forEach(([name, btn]) => {
        if (!btn) return;
        if (name === proto) btn.classList.add('active');
        else btn.classList.remove('active');
    });
    if (currentProtocolDisplay) currentProtocolDisplay.textContent = PROTOCOL_LABEL[proto] || proto;
    updateSourceBadge();

    currentUniverse = null;
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

if (btnIn1) btnIn1.addEventListener('click', () => switchProtocol('input1'));
if (btnIn2) btnIn2.addEventListener('click', () => switchProtocol('input2'));
if (btnUnified) btnUnified.addEventListener('click', () => switchProtocol('Unified'));

function switchUniverse(universeId) {
    currentUniverse = universeId;
    universeSelector.value = universeId;

    socket.emit('join-universe', { protocol: currentProtocol, universeId: universeId });

    renderGrids();
    renderActiveUniverses();
    updateSourceBadge();

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

// ------------------------------------------------------------- Modos de vista
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

function getIntensityColor(value) {
    if (value === 0) return 'var(--dmx-inactive)';
    const MathAlpha = (value / 255.0) * 0.9 + 0.1;
    return `rgba(0, 255, 136, ${MathAlpha})`;
}

function drawMiniCanvas(ctx, dataArr) {
    const imgData = ctx.createImageData(32, 16);
    const buf = new Uint32Array(imgData.data.buffer);

    for (let i = 0; i < 512; i++) {
        const val = dataArr[i];
        if (val === 0) {
            buf[i] = 0xff111111;
        } else {
            const opacity = (val / 255.0) * 0.9 + 0.1;
            const r = 0;
            const g = Math.floor(255 * opacity);
            const b = Math.floor(136 * opacity);
            buf[i] = (255 << 24) | (b << 16) | (g << 8) | r;
        }
    }
    ctx.putImageData(imgData, 0, 0);
}

// ------------------------------------------------------------------ Game loop
function renderLoop() {
    if (!isPaused) {
        universeDirty.forEach(key => {
            const dataMap = universeData.get(key);
            if (!dataMap) return;

            const mainChannels = gridsCache.get(key);
            if (mainChannels) {
                for (let i = 0; i < 512; i++) {
                    const val = dataMap[i];
                    const el = mainChannels[i];

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

            const mini = minimapCache.get(key);
            if (mini) {
                drawMiniCanvas(mini.ctx, dataMap);
            }
        });

        universeDirty.clear();
    }

    frames++;
    const now = performance.now();
    if (now - lastFpsTime >= 1000) {
        fpsCounter.textContent = frames;
        frames = 0;
        lastFpsTime = now;
    }

    requestAnimationFrame(renderLoop);
}

requestAnimationFrame(renderLoop);

// ------------------------------------------------------------- WebSockets
socket.on('connect', () => {
    connectionDot.classList.remove('disconnected');
    connectionDot.classList.add('connected');
    connectionText.textContent = 'Connected';
    socket.emit('join-universe', { protocol: currentProtocol, universeId: 'all' });
    socket.emit('get-network-interfaces');
    socket.emit('get-presets');
});

socket.on('disconnect', () => {
    connectionDot.classList.add('disconnected');
    connectionDot.classList.remove('connected');
    connectionText.textContent = 'Disconnected';
});

socket.on('active-universes', (payloadObj) => {
    activeUniverses = { input1: payloadObj.input1 || [], input2: payloadObj.input2 || [], Unified: payloadObj.Unified || [] };

    updateSelector();
    renderActiveUniverses();
    renderMinimap();
    renderChips();

    const activeList = activeUniverses[currentProtocol] || [];
    activeCount.textContent = activeList.length;

    if (currentUniverse === null && activeList.length > 0) {
        switchUniverse(activeList[0]);
    } else if (currentUniverse === 'all') {
        renderGrids();
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

        universeDirty.add(key);
    });
}

socket.on('dmx-data', (payload) => {
    const protocolIn = payload.protocol || 'Entrada1';
    const mapped = protocolIn === 'Unified' ? 'Unified' : (payload.input === 1 ? 'input2' : 'input1');
    if (mapped !== currentProtocol) return;

    const uni = payload.universe;
    const key = `${currentProtocol}-${uni}`;

    let dataMap = universeData.get(key);
    if (!dataMap) {
        dataMap = new Uint8Array(512);
        universeData.set(key, dataMap);
    }

    const incoming = payload.data;
    let isDirty = false;
    for (let i = 0; i < 512; i++) {
        if (dataMap[i] !== incoming[i]) {
            dataMap[i] = incoming[i];
            isDirty = true;
        }
    }

    if (isDirty) {
        universeDirty.add(key);
    }
});

// Muestra qué fuentes alimentan el universo que estamos mirando
function updateSourceBadge() {
    if (!sourceBadge) return;
    if (currentUniverse === null || currentUniverse === 'all') {
        sourceBadge.textContent = currentProtocol === 'Unified'
            ? 'Unified = Fuente 1 + Fuente 2'
            : `Viendo ${PROTOCOL_LABEL[currentProtocol]}`;
        return;
    }
    const info = unifiedInfo[currentUniverse];
    if (!info) {
        sourceBadge.textContent = `${PROTOCOL_LABEL[currentProtocol]} · universo ${currentUniverse}`;
        return;
    }
    const flags = info.present.map((p) => (p === 'input1' ? 'Fuente 1' : 'Fuente 2'));
    sourceBadge.textContent = `U${currentUniverse} · fuentes: ${flags.join(' + ') || '—'} · gana: ${info.winner === 'mix' ? 'mezcla (HTP)' : (PROTOCOL_LABEL[info.winner] || '—')}`;
}

// Detalle de fuentes por universo
socket.on('unified-info', (info) => {
    unifiedInfo = info || {};
    updateSourceBadge();
});

// Estado del bridge (en la raíz)
socket.on('bridge-stats', (st) => {
    if (!statsText || !st) return;
    const rec = st.received || [{}, {}];
    const bound = st.boundTo || [null, null];
    const proto = bridgeConfig ? bridgeConfig.inputs.map((e) => PROTOCOL_SHORT[e.protocol] || e.protocol) : ['—', '—'];
    const multid = [st.multicastGroups ? st.multicastGroups[0] : 0, st.multicastGroups ? st.multicastGroups[1] : 0];
    const muted = [st.droppedMuted ? st.droppedMuted[0] : 0, st.droppedMuted ? st.droppedMuted[1] : 0];

    const lineas = [
        `E1 · ${proto[0]}: ${(rec[0] || {}).paquetes || 0} pqt (${bound[0] || '—'}${multid[0] ? `, ${multid[0]} mc` : ''})`,
        `E2 · ${proto[1]}: ${(rec[1] || {}).paquetes || 0} pqt (${bound[1] || '—'}${multid[1] ? `, ${multid[1]} mc` : ''})`,
        `OUT · ${(st.sent || {}).artnet || 0} Art-Net · ${(st.sent || {}).sacn || 0} sACN`,
    ];
    if (muted[0] || muted[1]) {
        lineas.push(`<span class="warn">silenciados descartados: E1 ${muted[0]} · E2 ${muted[1]}</span>`);
    }
    if (st.lastSendError) lineas.push(`<span class="warn">⚠ ${st.lastSendError}</span>`);
    statsText.innerHTML = lineas.map((l) => `<div>${l}</div>`).join('');
});

// ------------------------------------------- Menú: entradas / unificación / salida
btnBridgeSettings.addEventListener('click', () => bridgeModal.classList.remove('hidden'));
btnCloseModal.addEventListener('click', () => bridgeModal.classList.add('hidden'));

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
    fillInterfaceSelect(INPUTS[0].iface, { includeAll: true });
    fillInterfaceSelect(INPUTS[1].iface, { includeAll: true });
    fillInterfaceSelect(selOutInterface, { includeDefault: true });

    interfaces.forEach(net => {
        const label = `${net.name} - ${net.address}`;
        [INPUTS[0].iface, INPUTS[1].iface, selOutInterface].forEach((select) => {
            if (!select) return;
            const opt = document.createElement('option');
            opt.value = net.address;
            opt.textContent = net.address === '127.0.0.1' ? `Localhost - ${net.address}` : label;
            select.appendChild(opt);
        });
    });

    if (bridgeConfig) applyConfigToMenu(bridgeConfig);
});

// Cada entrada muestra u oculta sus opciones según el protocolo elegido
function updateInputVisibility(input) {
    const esSacn = input.protocol.value === 'sacn';
    if (input.mcWrap) input.mcWrap.style.display = esSacn ? 'grid' : 'none';
    if (input.dot) input.dot.className = `dot-proto ${input.protocol.value}`;
}

INPUTS.forEach((input) => {
    input.protocol.addEventListener('change', () => updateInputVisibility(input));
});

function applyConfigToMenu(config) {
    bridgeConfig = config;
    const ins = config.inputs || [];

    INPUTS.forEach((input, i) => {
        const cfgIn = ins[i] || {};
        input.protocol.value = cfgIn.protocol || 'artnet';
        input.iface.value = cfgIn.interface || '0.0.0.0';
        input.enabled.checked = cfgIn.enabled !== false;
        input.mcFrom.value = cfgIn.multicastFrom !== undefined ? cfgIn.multicastFrom : 1;
        input.mcTo.value = cfgIn.multicastTo !== undefined ? cfgIn.multicastTo : 100;
        input.muted.value = (cfgIn.muted || []).join(', ');
        if (input.summary) input.summary.textContent = PROTOCOL_SHORT[cfgIn.protocol] || '';
        updateInputVisibility(input);
    });

    if (selMergeSources) selMergeSources.value = (config.merge && config.merge.sources) || 'both';

    const out = config.out || {};
    if (selOutProtocol) selOutProtocol.value = out.protocol || 'sacn';
    if (selOutInterface) selOutInterface.value = out.interface || '';
    if (selOutTargetMode) selOutTargetMode.value = out.targetMode || 'unicast';
    if (inputTargetIp) {
        inputTargetIp.value = out.targetIp || '127.0.0.1';
        inputTargetIp.disabled = out.targetMode !== 'unicast';
    }
    if (inOutPort) inOutPort.value = out.port || '';
    if (inOutRate) inOutRate.value = out.rate || 30;
    if (selectUniverseOffset) selectUniverseOffset.value = config.universeOffset || 0;

    if (toggleEnableRoot) toggleEnableRoot.checked = !!config.enabled;

    universeOffset = parseInt(config.universeOffset || 0);

    updateSelector();
    renderActiveUniverses();
    renderMinimap();
    renderChips();

    if (config.enabled) {
        statusBadge.textContent = 'BRIDGE ON';
        statusBadge.classList.replace('off', 'on');
        if (btnIn1) btnIn1.classList.add('bridge-on');
    } else {
        statusBadge.textContent = 'BRIDGE OFF';
        statusBadge.classList.replace('on', 'off');
    }
}

socket.on('bridge-config', (config) => applyConfigToMenu(config));

// Enable real-time conversion directo desde la raíz
if (toggleEnableRoot) {
    toggleEnableRoot.addEventListener('change', () => {
        socket.emit('update-bridge-config', { enabled: toggleEnableRoot.checked });
    });
}

if (selOutTargetMode) {
    selOutTargetMode.addEventListener('change', () => {
        if (inputTargetIp) inputTargetIp.disabled = selOutTargetMode.value !== 'unicast';
    });
}

// Chips: universos activos de cada entrada, clic para silenciar / reactivar
function renderChips() {
    INPUTS.forEach((input, i) => {
        if (!input.chips) return;
        const activos = activeUniverses[i === 0 ? 'input1' : 'input2'] || [];
        const silenciados = input.muted.value.split(',').map(v => parseInt(v.trim())).filter(v => !isNaN(v));
        const todos = Array.from(new Set([...activos, ...silenciados])).sort((a, b) => a - b);

        input.chips.innerHTML = '';
        if (todos.length === 0) {
            const vacio = document.createElement('span');
            vacio.className = 'chip-empty';
            vacio.textContent = 'Sin universos activos todavía';
            input.chips.appendChild(vacio);
            return;
        }
        todos.forEach((uni) => {
            const chip = document.createElement('span');
            const estaSilenciado = silenciados.includes(uni);
            chip.className = `chip${estaSilenciado ? ' muted' : ''}`;
            chip.textContent = `U${uni + universeOffset}`;
            chip.title = estaSilenciado ? 'Silenciado — clic para reactivar' : 'Activo — clic para silenciar';
            chip.addEventListener('click', () => {
                socket.emit('toggle-universe-mute', { input: i, universe: uni });
            });
            input.chips.appendChild(chip);
        });
    });
}

// El texto de silenciados también se puede editar a mano
INPUTS.forEach((input, i) => {
    input.muted.addEventListener('change', () => {
        const arr = input.muted.value.split(',').map(v => parseInt(v.trim())).filter(v => !isNaN(v));
        socket.emit('update-bridge-config', { inputs: readInputs().map((e, idx) => (idx === i ? Object.assign({}, e, { muted: arr }) : e)) });
    });
});

function readInputs() {
    return INPUTS.map((input) => ({
        protocol: input.protocol.value,
        enabled: input.enabled.checked,
        interface: input.iface.value,
        muted: input.muted.value.split(',').map(v => parseInt(v.trim())).filter(v => !isNaN(v)),
        multicastFrom: parseInt(input.mcFrom.value) || 0,
        multicastTo: parseInt(input.mcTo.value) || 0,
        joinMulticast: true,
    }));
}

// Arma la configuración completa desde el menú
function readBridgeConfig() {
    const portRaw = inOutPort ? inOutPort.value.trim() : '';
    return {
        inputs: readInputs(),
        merge: { sources: selMergeSources ? selMergeSources.value : 'both' },
        out: {
            protocol: selOutProtocol ? selOutProtocol.value : 'sacn',
            interface: selOutInterface ? selOutInterface.value : '',
            targetMode: selOutTargetMode ? selOutTargetMode.value : 'unicast',
            targetIp: inputTargetIp ? inputTargetIp.value.trim() : '127.0.0.1',
            port: portRaw === '' ? null : parseInt(portRaw),
            rate: parseInt(inOutRate ? inOutRate.value : 30) || 30,
        },
        universeOffset: parseInt(selectUniverseOffset.value) || 0,
        enabled: toggleEnableRoot ? toggleEnableRoot.checked : false,
    };
}

btnSaveBridge.addEventListener('click', () => {
    socket.emit('update-bridge-config', readBridgeConfig());
    bridgeModal.classList.add('hidden');
});

// Deep-link: http://localhost:3000/#bridge abre el menú directamente
if (location.hash === '#bridge') {
    bridgeModal.classList.remove('hidden');
}

// ------------------------------------------------------------------- Presets
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
    if (name) socket.emit('load-preset', name);
});
