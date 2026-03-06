document.addEventListener('DOMContentLoaded', () => {
    // Initialize icons
    lucide.createIcons();

    const socket = io();

    // Elements
    const statusBadge = document.getElementById('app-status');
    const cardHost = document.getElementById('card-host');
    const cardJoin = document.getElementById('card-join');

    // Host Buttons & Inputs
    const btnStartHost = document.getElementById('btn-start-host');
    const btnStopHost = document.getElementById('btn-stop-host');
    const btnGenerateLink = document.getElementById('btn-generate-link');
    const linkContainer = document.getElementById('link-container');
    const publicLink = document.getElementById('public-link');
    const btnCopy = document.getElementById('btn-copy');

    // Join Buttons & Inputs
    const joinUrl = document.getElementById('join-url');
    const btnStartJoin = document.getElementById('btn-start-join');
    const btnStopJoin = document.getElementById('btn-stop-join');
    const joinStatus = document.getElementById('join-status');

    // Stats
    const statRx = document.getElementById('stat-rx');
    const statTx = document.getElementById('stat-tx');
    const statUni = document.getElementById('stat-uni');

    // State
    let currentMode = 'IDLE';

    // --- Socket Listeners ---
    socket.on('status', (data) => {
        currentMode = data.mode;
        updateUIState(data);
    });

    socket.on('tunnel-url', (data) => {
        if (data.error) {
            publicLink.value = "Error: " + data.error;
        } else if (data.url) {
            publicLink.value = data.url;
        } else {
            // Closed
            linkContainer.classList.add('hidden');
        }
    });

    socket.on('stats-update', (data) => {
        statRx.innerText = formatNumber(data.packetsReceivedTotal);
        statTx.innerText = formatNumber(data.packetsSentTotal);
        statUni.innerText = data.activeUniverses.length > 0 ? data.activeUniverses.join(', ') : '-';
    });

    // --- UI Actions ---
    btnStartHost.addEventListener('click', () => {
        socket.emit('ui-start-host');
    });

    btnStopHost.addEventListener('click', () => {
        socket.emit('ui-stop-host');
        // also hide link
        linkContainer.classList.add('hidden');
        publicLink.value = "Generating...";
    });

    btnGenerateLink.addEventListener('click', () => {
        linkContainer.classList.remove('hidden');
        publicLink.value = "Generating tunnel...";
        socket.emit('ui-generate-link');
    });

    btnCopy.addEventListener('click', () => {
        publicLink.select();
        document.execCommand('copy');
        btnCopy.innerText = "Copied!";
        setTimeout(() => btnCopy.innerText = "Copy", 2000);
    });

    btnStartJoin.addEventListener('click', () => {
        const url = joinUrl.value.trim();
        if (!url) return alert("Please enter a valid Host URL");
        socket.emit('ui-start-join', { url });
    });

    btnStopJoin.addEventListener('click', () => {
        socket.emit('ui-stop-join');
    });

    // --- Helpers ---
    function updateUIState(data) {
        if (currentMode === 'IDLE') {
            statusBadge.innerText = 'IDLE';
            statusBadge.className = 'status-badge';

            cardHost.classList.remove('disabled');
            cardJoin.classList.remove('disabled');

            // Reset Host
            btnStartHost.classList.remove('hidden');
            btnStopHost.classList.add('hidden');
            btnGenerateLink.classList.add('hidden');
            linkContainer.classList.add('hidden');

            // Reset Join
            btnStartJoin.classList.remove('hidden');
            btnStopJoin.classList.add('hidden');
            joinStatus.classList.add('hidden');
            joinUrl.disabled = false;
        }
        else if (currentMode === 'HOST') {
            statusBadge.innerText = 'HOSTING';
            statusBadge.className = 'status-badge host';

            cardHost.classList.remove('disabled');
            cardJoin.classList.add('disabled');

            btnStartHost.classList.add('hidden');
            btnStopHost.classList.remove('hidden');
            btnGenerateLink.classList.remove('hidden');
        }
        else if (currentMode === 'JOIN') {
            statusBadge.innerText = 'RECEIVING';
            statusBadge.className = 'status-badge join';

            cardHost.classList.add('disabled');
            cardJoin.classList.remove('disabled');

            btnStartJoin.classList.add('hidden');
            btnStopJoin.classList.remove('hidden');
            joinUrl.disabled = true;

            joinStatus.classList.remove('hidden');

            if (data.connected) {
                joinStatus.innerHTML = '<div class="dot connected"></div> Connected to Remote Host';
                joinStatus.className = 'connection-status connected';
            } else {
                joinStatus.innerHTML = '<div class="dot connecting"></div> Connecting to Remote Host...';
                joinStatus.className = 'connection-status';
            }
        }
    }

    function formatNumber(num) {
        // e.g., 1,234,567
        return new Intl.NumberFormat().format(num);
    }
});
