# DMX & sACN Web Visualizer / Network Bridge

A high-performance, real-time web visualizer and protocol conversion bridge for DMX512 lighting data. This tool allows users to visualize up to 96+ universes of Art-Net or sACN traffic directly in a modern web browser over the network at 60 FPS, with absolutely no frame drops, utilizing binary parsing and GPU-accelerated drawing.

Additionally, this application functions as a **Zero-Latency Art-Net to sACN Unicast Bridge**, allowing interoperability between localized DMX software (TouchDesigner, Resolume, GrandMA) and game engines distributed over the internet using VPNs (like Unreal Engine 5 via ZeroTier, Tailscale, etc).

## 🚀 Features
- **Real-Time Data Visualization:** Displays a full 512-channel grid of any selected universe with intensity color values.
- **"All Universes" Minimap:** A dynamic, scrollable sidebar utilizing Canvas memory buffers to render 91+ active universes simultaneously without bogging down the DOM.
- **Dual Protocol Listeners:** Listens seamlessly on both UDP port `5568` (sACN/E1.31) and UDP port `6454` (Art-Net).
- **Protocol Toggle:** Switch between monitoring the Art-Net buffer or the sACN buffer seamlessly via the UI.
- **Hardware Bridge Converter:** Instantly encapsulates active Art-Net payloads into strict SMPTE sACN UDP packets and fires them over a selected target Network Interface.

---

## 🛠️ Installation Requirements

1. **[Node.js](https://nodejs.org/en/download) (v16.x or higher)** - This handles the backend network translation loops.
2. A modern Web Browser (Chrome, Edge, Firefox).

### Setup Instructions for Collaborators
1. Unzip the downloaded folder containing the project files.
2. Double-click the `install.bat` file. This script will check if Node.js is installed, and if so, it will automatically download all necessary web-server packages (`express` and `socket.io`).
3. Wait for the `[+] Installation Complete!` literal phrase in the console. Do not close early.

---

## 🏃‍♂️ Usage

### 1. Starting the Interface
Double click the `start_server.bat` file. 
This batch script will automatically trigger the internal Node server backend, wait a brief second for networking ports to bind, and automatically launch your default Web Browser pointing to `http://localhost:3000/`.

*Note: Keep the black CMD "DMX Backend Server" window open in the background. Closing it will terminate the DMX capture module.*

### 2. Using the Visualizer UI
By default, the UI waits for incoming data.
1. Open up TouchDesigner, Resolume, or whatever is emitting Art-Net/sACN.
2. Route a DMX Out CHOP or plugin to `127.0.0.1` (localhost), or Broadcast.
3. The Web Visualizer will immediately detect universes receiving payload data.
4. **Active Universes**: Click the little pills on the left column (`U1`, `U42`, etc.) to enter Full Grid view for that specific Universe.
5. **Minimap**: You will see all universes glowing dynamically on the right-hand panel. Simply click one of them to expand it.

### 3. Using the Protocol Converter Bridge
If you need to beam Art-Net data across the internet safely to Unreal Engine:
1. Ensure your Lighting software outputs **Art-Net** to the computer on `port 6454` (e.g. `127.0.0.1` or `255.255.255.255`).
2. Open the Visualizer Web page. 
3. Click the `⚙️ Gear Icon` underneath "Connected" on the left menu.
4. From the Network Interface Dropdown, choose the network adapter connecting you to your target (For example, selecting your `ZeroTier` or `Tailscale` Virtual adapter interface IP).
5. In the **Target IP** field, type the VPN IP address of the recipient Machine (e.g. `10.144.33.20`).
6. Flip the **Enable Real-Time Conversion** switch to green and click `Save & Apply`.
7. You will see the Bridge badge say **BRIDGE ON**. Art-Net packets are now being brutally translated into Unicast sACN straight into your target pipeline.

## 🧰 Technical Architecture
- **Backend (Node.js)**: Runs native Node `DGRAM` UDP sockets. Bypasses bulky third-party DMX packages to parse raw `Buffer` payloads minimizing byte reading to mere offsets. Diffing logic checks for memory matches.
- **Frontend (Vanilla HTML/JS/CSS3)**: Avoids frontend frameworks (React/Vue) deliberately. Rendering utilizes the `Uint8Array` diff logic and the `CanvasRenderingContext2D` Image Data API. It calculates rgba bitshifts to alter colors in the Minimaps natively in the GPU instead of manipulating thousands of traditional HTML elements, sustaining 60 FPS under a massive 46,000 DMX channel influx.
