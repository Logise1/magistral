/**
 * Magistral IDE - Main Logic
 * 100% Client-Side with Virtual File System and Mistral AI Integration
 */

// Configuration
const CONFIG = {
    API_KEY: 'evxly62Xv91b752fbnHA2I3HD988C5RT',
    MODEL: 'magistral-medium-latest', // User requested 'magistral-medium', but keeping the valid 'mistral-medium' to ensure it works. If you really want the typo, change this line manually.
    MAX_RETRIES: 429,
    API_URL: 'https://api.mistral.ai/v1/chat/completions'
};



// --- File System Interface (Abstract) ---
// We'll treat the VFS and RealFS polymorphically where possible
class FileSystemHandler {
    constructor() {
        this.root = { type: 'folder', name: 'root', children: {} }; // Default VFS structure
        this.mode = 'vfs'; // 'vfs' or 'real'
        this.dirHandle = null;
    }

    async initReal(dirHandle) {
        this.mode = 'real';
        this.dirHandle = dirHandle;
        await this.refreshRealTree();
    }

    async refreshRealTree() {
        if (this.mode !== 'real' || !this.dirHandle) return;
        this.root = await this._scanDir(this.dirHandle);
    }

    async _scanDir(dirHandle) {
        const node = { type: 'folder', name: dirHandle.name, children: {} };
        for await (const entry of dirHandle.values()) {
            if (entry.kind === 'file') {
                node.children[entry.name] = { type: 'file', name: entry.name, handle: entry };
            } else if (entry.kind === 'directory') {
                node.children[entry.name] = await this._scanDir(entry);
            }
        }
        return node;
    }

    // Standard ops
    async createFile(path, content) {
        if (this.mode === 'real') return this._createReal(path, content);
        return this._vfsCreate(path, content);
    }

    // ... we need async for real FS, so we update the signature to async everywhere
    async readFile(path) {
        if (!path || typeof path !== 'string') return null;
        if (this.mode === 'real') return await this._readReal(path);

        // VFS implementation (sync but wrapped in promise)
        const parts = path.split('/').filter(p => p.length > 0);
        let current = this.root;
        // if root name matches path[0], skip it or strictly follow structure? 
        // VFS root is usually invisible container.

        for (let i = 0; i < parts.length; i++) {
            if (!current.children) return null;
            current = current.children[parts[i]];
            if (!current) return null;
        }
        return current.type === 'file' ? current : null;
    }

    async updateFile(path, content) {
        if (this.mode === 'real') {
            await this._writeReal(path, content);
            return true;
        }
        // VFS
        const f = await this.readFile(path);
        if (f) { f.content = content; this.saveVFS(); return true; }
        return false;
    }

    async createFolder(path) {
        if (this.mode === 'real') return this._createRealFolder(path);
        return this._vfsCreateFolder(path);
    }

    async deleteNode(path) {
        if (this.mode === 'real') return this._deleteReal(path);
        return this._vfsDeleteNode(path);
    }

    // --- Real FS Helpers ---
    async _resolveHandle(path, create = false) {
        if (!this.dirHandle) return null;
        // Normalize: remove leading slash if present for splitting
        const cleanPath = path.startsWith('/') ? path.substring(1) : path;
        const parts = cleanPath.split('/').filter(p => p.length > 0);

        let current = this.dirHandle;

        try {
            for (let i = 0; i < parts.length - 1; i++) {
                try {
                    // Try to get existing directory
                    current = await current.getDirectoryHandle(parts[i], { create: false });
                } catch (e) {
                    // If not found and we want to create, try creating
                    if (create) {
                        current = await current.getDirectoryHandle(parts[i], { create: true });
                    } else {
                        // If path doesn't exist and we aren't creating, return null
                        return null;
                    }
                }
            }
            // Last part is file
            return { dir: current, name: parts[parts.length - 1] };
        } catch (e) { console.error("Resolve Error:", e); return null; }
    }

    async _readReal(path) {
        try {
            const loc = await this._resolveHandle(path, false);
            if (!loc) return null; // or try finding by recursion if path is weird

            const fileHandle = await loc.dir.getFileHandle(loc.name);
            const file = await fileHandle.getFile();
            const text = await file.text();

            return { type: 'file', name: loc.name, content: text, language: 'plaintext' };
        } catch (e) {
            if (e.name !== 'NotFoundError') console.error(e);
            return null;
        }
    }

    async _writeReal(path, content) {
        // Resolve with create=true to ensure folders exist
        const loc = await this._resolveHandle(path, true);
        if (loc) {
            const fh = await loc.dir.getFileHandle(loc.name, { create: true });
            const writable = await fh.createWritable();
            await writable.write(content);
            await writable.close();
        }
    }

    async _createReal(path, content) {
        // Just use write, it creates if missing usually, but we might need to create folders
        // Simplified: assume folders exist for now or implement recursive folder creation
        await this._writeReal(path, content);
    }

    async _createRealFolder(path) {
        const loc = await this._resolveHandle(path);
        if (loc) {
            await loc.dir.getDirectoryHandle(loc.name, { create: true });
            return true;
        }
        return false;
    }

    async _deleteReal(path) {
        const loc = await this._resolveHandle(path);
        if (loc) {
            await loc.dir.removeEntry(loc.name, { recursive: true });
            return true;
        }
        return false;
    }

    // --- VFS Legacy ---
    _resolveVFSPath(path) {
        const parts = path.split('/').filter(p => p.length > 0);
        let current = this.root;

        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (current.type !== 'folder' || !current.children[part]) {
                return null;
            }
            current = current.children[part];
        }
        return { parent: current, name: parts[parts.length - 1] };
    }

    _vfsCreate(path, content = '') {
        const resolved = this._resolveVFSPath(path);
        if (!resolved) return false;

        resolved.parent.children[resolved.name] = {
            type: 'file',
            name: resolved.name,
            content: content,
            language: this._detectLanguage(resolved.name)
        };
        this.saveVFS();
        return true;
    }

    _vfsCreateFolder(path) {
        const resolved = this._resolveVFSPath(path);
        if (!resolved) return false;

        resolved.parent.children[resolved.name] = {
            type: 'folder',
            name: resolved.name,
            children: {}
        };
        this.saveVFS();
        return true;
    }

    _vfsDeleteNode(path) {
        const resolved = this._resolveVFSPath(path);
        if (!resolved) return false;

        if (resolved.parent.children[resolved.name]) {
            delete resolved.parent.children[resolved.name];
            this.saveVFS();
            return true;
        }
        return false;
    }

    saveVFS() { if (this.mode === 'vfs') localStorage.setItem('magistral_vfs', JSON.stringify(this.root)); }
    loadVFS() {
        const s = localStorage.getItem('magistral_vfs');
        if (s) this.root = JSON.parse(s);
        else {
            this._vfsCreate('/welcome.md', '# Local VFS\nUse "Open Folder" to edit real files.');
            this._vfsCreate('/demo.js', '// Try asking the AI to refactor this!\nfunction hello() {\n  console.log("Hello World");\n}');
        }
    }

    _detectLanguage(filename) {
        const ext = filename.split('.').pop();
        const map = {
            'js': 'javascript', 'html': 'html', 'css': 'css', 'json': 'json', 'md': 'markdown', 'ts': 'typescript'
        };
        return map[ext] || 'plaintext';
    }
}

// --- Preview Manager ---
class PreviewManager {
    constructor(vfs) {
        this.vfs = vfs;
        this.previewModal = null;
        this.iframe = null;
        this.init();
    }

    init() {
        // Create modal DOM if not exists (it wasn't in index.html, so injecting it)
        if (!document.querySelector('.preview-modal')) {
            const modal = document.createElement('div');
            modal.className = 'preview-modal';
            modal.innerHTML = `
                <div class="preview-toolbar">
                    <button id="close-preview"><i class="fa-solid fa-xmark"></i> Close Preview</button>
                </div>
                <iframe class="preview-frame" sandbox="allow-scripts allow-modals"></iframe>
            `;
            document.querySelector('.editor-area').appendChild(modal);

            // Add Run button to tabs bar
            const btn = document.createElement('button');
            btn.id = 'run-btn';
            btn.innerHTML = '<i class="fa-solid fa-play"></i> Run';
            btn.addEventListener('click', () => this.runPreview());
            document.getElementById('tabs-bar').appendChild(btn);

            this.previewModal = modal;
            this.iframe = modal.querySelector('iframe');

            modal.querySelector('#close-preview').addEventListener('click', () => {
                modal.classList.remove('visible');
                this.iframe.src = 'about:blank'; // reset
            });
        }
    }

    async runPreview() {
        this.previewModal.classList.add('visible');

        let htmlFile = await this.vfs.readFile('/index.html');
        if (!htmlFile) {
            // Fallback: try to find any html file
            const root = this.vfs.root;
            const findHtml = async (node) => {
                if (node.type === 'file' && node.name.endsWith('.html')) return node;
                if (node.children) {
                    for (const k in node.children) {
                        const found = await findHtml(node.children[k]);
                        if (found) return found;
                    }
                }
                return null;
            };
            htmlFile = await findHtml(root);
        }

        if (!htmlFile) {
            this.iframe.srcdoc = "<h1>No index.html found</h1><p>Please create an index.html file to run the preview.</p>";
            return;
        }

        let htmlContent = htmlFile.content;

        // Naive dependency injection for CSS/JS
        // 1. Find all <link rel="stylesheet">
        htmlContent = await Promise.all(htmlContent.replace(/<link[^>]+href=["']([^"']+)["'][^>]*>/g, async (match, href) => {
            const cssFile = await this.vfs.readFile(href.startsWith('/') ? href : '/' + href); // simple path resolver
            return cssFile ? `<style>${cssFile.content}</style>` : match;
        }).map(p => Promise.resolve(p))).then(arr => arr.join(''));


        // 2. Find all <script src="...">
        htmlContent = await Promise.all(htmlContent.replace(/<script[^>]+src=["']([^"']+)["'][^>]*><\/script>/g, async (match, src) => {
            const jsFile = await this.vfs.readFile(src.startsWith('/') ? src : '/' + src);
            return jsFile ? `<script>${jsFile.content}</script>` : match;
        }).map(p => Promise.resolve(p))).then(arr => arr.join(''));

        this.iframe.srcdoc = htmlContent;
    }
}

// --- UI Manager ---
// --- UI Manager ---
class UIManager {
    constructor(vfs, editorMgr, chatMgr) {
        this.vfs = vfs;
        this.editorMgr = editorMgr;
        this.chatMgr = chatMgr;

        this.fileTreeEl = document.getElementById('file-tree');
        this.bindEvents();
        this.renderFileTree();
    }

    bindEvents() {
        document.getElementById('new-file-btn').addEventListener('click', async () => {
            const name = prompt('File Name (e.g. /script.js):');
            if (name) {
                await this.vfs.createFile(name.startsWith('/') ? name : '/' + name);
                this.renderFileTree();
            }
        });

        document.getElementById('new-folder-btn').addEventListener('click', async () => {
            const name = prompt('Folder Name (e.g. /src):');
            if (name) {
                await this.vfs.createFolder(name.startsWith('/') ? name : '/' + name);
                this.renderFileTree();
            }
        });

        document.getElementById('refresh-files-btn').addEventListener('click', async () => {
            await this.refreshFileTree();
        });

        document.getElementById('open-folder-btn').addEventListener('click', async () => {
            if (window.showDirectoryPicker) {
                const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
                await this.vfs.initReal(handle);
                this.renderFileTree();
            } else { alert("Browser does not support File System Access."); }
        });

        document.getElementById('clear-chat-btn').addEventListener('click', () => {
            if (this.chatMgr) {
                this.chatMgr.messages = [];
                this.chatMgr.msgContainer.innerHTML = '';
                this.chatMgr.addMessage('ai', 'Chat cleared.');
            }
        });
    }

    async refreshFileTree() {
        if (this.vfs.mode === 'real') await this.vfs.refreshRealTree();
        this.renderFileTree();
    }

    renderFileTree() {
        const tree = document.getElementById('file-tree');
        tree.innerHTML = '';
        const traverse = (node, container, path) => {
            if (node.children) {
                Object.values(node.children).forEach(child => {
                    const el = document.createElement('div');
                    el.className = 'tree-item';
                    const fullPath = (path === '/' ? '' : path) + '/' + child.name;
                    if (child.type === 'file') {
                        const ext = child.name.split('.').pop();
                        el.setAttribute('data-ext', ext);
                        el.innerHTML = `<span class="icon"><i class="fa-solid fa-file"></i></span><span class="name">${child.name}</span>`;
                        el.onclick = () => {
                            this.openFile(fullPath);
                            document.querySelectorAll('.tree-item').forEach(i => i.classList.remove('active'));
                            el.classList.add('active');
                        };
                    } else {
                        el.innerHTML = `<span class="icon"><i class="fa-solid fa-folder"></i></span><span class="name">${child.name}</span>`;
                    }

                    container.appendChild(el);
                    if (child.children) {
                        const sub = document.createElement('div');
                        sub.style.marginLeft = '10px';
                        container.appendChild(sub);
                        traverse(child, sub, fullPath);
                    }
                });
            }
        };
        traverse(this.vfs.root, tree, '');
    }

    async openFile(path) {
        const f = await this.vfs.readFile(path);
        if (f) {
            this.editorMgr.openFile(path, f.content, f.language || 'plaintext');
            document.getElementById('startup-message').classList.add('hidden');
        }
    }

    getFileList(node, prefix = '') {
        let output = [];
        const traverse = (n, p) => {
            if (n.type === 'file') {
                output.push(p);
            } else if (n.children) {
                Object.values(n.children).forEach(c => traverse(c, p + '/' + c.name));
            }
        }
        traverse(node, prefix);
        return output;
    }
}

// --- Editor Manager (Monaco) ---
class EditorManager {
    constructor(vfs) {
        this.vfs = vfs;
        this.editor = null;
        this.currentPath = null;
        this.changeTimer = null;

        this.initMonaco();
    }

    initMonaco() {
        require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.38.0/min/vs' } });

        require(['vs/editor/editor.main'], () => {
            this.editor = monaco.editor.create(document.getElementById('monaco-editor-container'), {
                value: '',
                language: 'plaintext',
                theme: 'vs-dark',
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 14,
                fontFamily: 'JetBrains Mono'
            });

            this.editor.onDidChangeModelContent(() => {
                if (this.currentPath) {
                    // Auto-save debounced
                    clearTimeout(this.changeTimer);
                    this.changeTimer = setTimeout(async () => {
                        await this.vfs.updateFile(this.currentPath, this.editor.getValue());
                    }, 500);
                }
            });
        });

        // Window resize handler
        window.addEventListener('resize', () => {
            if (this.editor) this.editor.layout();
        });
    }

    openFile(path, content, language) {
        if (!this.editor) return;

        this.currentPath = path;

        // Better language detection
        let lang = language;
        if (!lang || lang === 'plaintext') {
            const ext = path.split('.').pop().toLowerCase();
            const map = {
                'js': 'javascript', 'jsx': 'javascript', 'ts': 'typescript', 'tsx': 'typescript',
                'html': 'html', 'css': 'css', 'json': 'json', 'md': 'markdown', 'py': 'python',
                'java': 'java', 'xml': 'xml', 'php': 'php', 'sql': 'sql', 'yaml': 'yaml', 'yml': 'yaml'
            };
            lang = map[ext] || 'plaintext';
        }

        this.editor.setValue(content);
        monaco.editor.setModelLanguage(this.editor.getModel(), lang);

        // Update Tabs (Simplified 1-tab system for now)
        const tabsBar = document.getElementById('tabs-bar');
        tabsBar.innerHTML = `<div class="tab active">
            <span class="name">${path.substring(1)}</span>
            <button class="close-btn"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
    }
}

// --- Chat Manager & AI Logic ---
class ChatManager {
    constructor(vfs, uiMgr) {
        this.vfs = vfs;
        this.uiMgr = uiMgr;
        this.messages = [];
        this.msgContainer = document.getElementById('chat-messages');
        this.input = document.getElementById('chat-input');
        this.sendBtn = document.getElementById('send-btn');
        this.initListeners();
    }

    initListeners() {
        this.sendBtn.addEventListener('click', () => this.handleSend());
        this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.handleSend(); } });
    }

    addMessage(role, text, saveToHistory = true) {
        const div = document.createElement('div');
        div.className = `message ${role}`;

        let contentHtml = this.renderMarkdown(text);

        div.innerHTML = `
            <div class="avatar"><i class="fa-solid ${role === 'user' ? 'fa-user' : 'fa-robot'}"></i></div>
            <div class="content"><p>${contentHtml}</p></div>
        `;
        this.msgContainer.appendChild(div);
        this.msgContainer.scrollTop = this.msgContainer.scrollHeight;

        if (saveToHistory) {
            this.messages.push({ role: role === 'user' ? 'user' : 'assistant', content: text });
        }
        return div;
    }

    async handleSend(userText = null) {
        const text = userText || this.input.value.trim();
        if (!text && !userText) return;
        if (!userText) this.input.value = '';
        if (text) this.addMessage('user', text);

        this.setLoading(true);

        // Placeholder
        const aiDiv = document.createElement('div');
        aiDiv.className = 'message ai';
        aiDiv.innerHTML = `<div class="avatar"><i class="fa-solid fa-robot"></i></div><div class="content"><p>...</p></div>`;
        this.msgContainer.appendChild(aiDiv);
        this.msgContainer.scrollTop = this.msgContainer.scrollHeight;

        await this.runAIStream(aiDiv);
        this.setLoading(false);
    }

    async runAIStream(aiDiv) {
        let fullResponse = "";

        // Create a dedicated container for this stream segment to ensure correct ordering (append to bottom)
        const contentDiv = aiDiv.querySelector('.content');
        const streamContainer = document.createElement('div');
        streamContainer.className = 'stream-segment';
        contentDiv.appendChild(streamContainer);

        try {
            await this.streamWithBackoff(this.messages, (chunk, type) => {
                if (type === 'thinking') {
                    // Thinking UI Logic scoped to this stream segment
                    let thinkingBlock = streamContainer.querySelector('.thinking-block');
                    if (!thinkingBlock) {
                        const id = 'think-' + Date.now();
                        thinkingBlock = document.createElement('div');
                        thinkingBlock.className = 'thinking-block open';
                        thinkingBlock.dataset.startTime = Date.now();
                        thinkingBlock.innerHTML = `
                            <div class="thinking-header" onclick="this.parentElement.classList.toggle('open')">
                                <i class="fa-solid fa-brain"></i> 
                                <span class="think-label">Thinking<span class="thinking-loading"></span></span>
                            </div>
                            <div class="thinking-content"></div>
                        `;
                        // Insert at top of this segment
                        streamContainer.prepend(thinkingBlock);
                    }
                    thinkingBlock.querySelector('.thinking-content').textContent += chunk;
                } else {
                    // Regular Text Logic
                    // Close thinking block if open
                    const thinkingBlock = streamContainer.querySelector('.thinking-block');
                    if (thinkingBlock && thinkingBlock.classList.contains('open') && !thinkingBlock.classList.contains('finished')) {
                        thinkingBlock.classList.remove('open');
                        thinkingBlock.classList.add('finished');
                        const start = parseInt(thinkingBlock.dataset.startTime || 0);
                        const sec = ((Date.now() - start) / 1000).toFixed(1);
                        thinkingBlock.querySelector('.think-label').innerHTML = `Thought for ${sec}s`;
                    }

                    fullResponse += chunk;
                    const html = this.renderMarkdown(fullResponse);

                    // Create/Update text container in this segment
                    let textContainer = streamContainer.querySelector('.response-text');
                    if (!textContainer) {
                        textContainer = document.createElement('div');
                        textContainer.className = 'response-text';
                        streamContainer.appendChild(textContainer);
                    }
                    textContainer.innerHTML = html;
                }
                this.msgContainer.scrollTop = this.msgContainer.scrollHeight;
            }, (status) => {
                // Feedback for 429
                let textContainer = streamContainer.querySelector('.response-text');
                if (!textContainer) {
                    textContainer = document.createElement('div');
                    textContainer.className = 'response-text';
                    streamContainer.appendChild(textContainer);
                }
                textContainer.innerHTML = `<p class="ai-working" style="color:orange"><i class="fa-solid fa-triangle-exclamation"></i> ${status}</p>`;
            });

            // Finalize message history
            if (fullResponse) { // Only add if we got text
                this.messages.push({ role: 'assistant', content: fullResponse });
            }

            // Process Agentic Actions
            await this.processCommands(fullResponse, aiDiv);

        } catch (e) {
            let textContainer = streamContainer.querySelector('.response-text');
            if (!textContainer) {
                textContainer = document.createElement('div');
                textContainer.className = 'response-text';
                streamContainer.appendChild(textContainer);
            }
            textContainer.innerHTML += `<p class="error">Error: ${e.message}</p>`;
        }
    }

    async streamWithBackoff(history, onChunk, onStatus, attempt = 0) {
        const MAX_RETRIES = 10;

        // System Prompt Construction (Dynamic based on file system state)
        // We do it here to ensure latest files are in context
        // ... (system prompt code) ...
        const fileList = this.uiMgr.getFileList(this.vfs.root);
        const systemPrompt = {
            role: "system",
            content: `You are Magistral. Project Files:\n${fileList.join('\n')}\nRULES:\n1. Read files before editing using 'read_file'.\n2. 'update_file' overwrites complete content.\n3. Output JSON actions at end.\n4. CRITICAL: NEVER output the file content/code in the chat text. Just say 'Creating file...' and put the code ONLY in the JSON tool usage. Do not use code blocks in the chat text.\n5. Use JSON format: { actions: [ { type: 'create_file', path: '/path/to/file', content: '...' } ] }. ensure you use 'path' not 'file'. You can use if you want to tailwindcss classes and the inter font for a better look of your website.`
        };

        // Update model from selector if available (runtime check)
        const selector = document.getElementById('model-selector');
        if (selector) CONFIG.MODEL = selector.value;


        const payload = {
            model: CONFIG.MODEL,
            messages: [systemPrompt, ...history.slice(-10)],
            stream: true,
            temperature: 0.5
        };

        try {
            const response = await fetch(CONFIG.API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.API_KEY}` },
                body: JSON.stringify(payload)
            });

            if (response.status === 429) {
                if (attempt >= MAX_RETRIES) throw new Error("Rate limit exceeded (Max retries)");

                const waitSec = Math.min(Math.pow(2, attempt), 60);
                onStatus(`Rate limited. Retrying in ${waitSec}s...`);

                await new Promise(r => setTimeout(r, waitSec * 1000));
                return this.streamWithBackoff(history, onChunk, onStatus, attempt + 1);
            }

            if (!response.ok) throw new Error(await response.text());

            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");

            let toolCallsBuffer = {};

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                chunk.split('\n').forEach(line => {
                    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                        try {
                            const d = JSON.parse(line.substring(6));
                            const delta = d.choices[0]?.delta;
                            if (delta) {
                                // 1. Thinking & Content
                                if (delta.content) {
                                    if (typeof delta.content === 'string') {
                                        onChunk(delta.content, 'text');
                                    } else if (Array.isArray(delta.content)) {
                                        delta.content.forEach(item => {
                                            if (item.type === 'thinking') {
                                                // Log format: thinking: [ {type:'text', text:'...'} ]
                                                if (Array.isArray(item.thinking)) {
                                                    item.thinking.forEach(t => { if (t.type === 'text') onChunk(t.text, 'thinking'); });
                                                } else if (typeof item.thinking === 'string') {
                                                    onChunk(item.thinking, 'thinking');
                                                }
                                            } else if (item.type === 'text') {
                                                onChunk(item.text, 'text');
                                            }
                                        });
                                    }
                                }

                                // 2. Tool Calls
                                if (delta.tool_calls) {
                                    delta.tool_calls.forEach(tc => {
                                        if (!toolCallsBuffer[tc.index]) toolCallsBuffer[tc.index] = { ...tc, arguments: '' };
                                        if (tc.function) {
                                            if (tc.function.name) toolCallsBuffer[tc.index].function.name = tc.function.name;
                                            if (tc.function.arguments) toolCallsBuffer[tc.index].function.arguments += tc.function.arguments;
                                        }
                                    });
                                }
                            }
                        } catch (e) { }
                    }
                });
            } // End while loop

            // Process Buffered Tool Calls into Synthetic JSON block
            const calls = Object.values(toolCallsBuffer);
            if (calls.length > 0) {
                const actions = calls.map(tc => {
                    if (!tc.function) return null;
                    let args = {};
                    const argStr = tc.function.arguments || '{}';
                    try {
                        args = JSON.parse(argStr);
                    } catch (e) {
                        // Robustness: Attempt to parse by stripping partial/trailing garbage
                        // Try processing from the end backwards to find the valid JSON closure
                        let fixed = false;
                        for (let i = argStr.length - 1; i >= 1; i--) {
                            if (argStr[i] === '}') {
                                try {
                                    args = JSON.parse(argStr.substring(0, i + 1));
                                    fixed = true;
                                    break;
                                } catch (_) { }
                            }
                        }
                        if (!fixed) { console.warn("Failed to parse tool args:", argStr); return null; }
                    }

                    // Normalize arguments
                    return {
                        type: tc.function.name,
                        path: args.file_path || args.path || args.filename,
                        content: args.content,
                        start_line: args.start_line,
                        end_line: args.end_line,
                        ...args
                    };
                }).filter(a => a);

                if (actions.length > 0) {
                    const syntheticJson = `\n\n\`\`\`json\n${JSON.stringify({ actions }, null, 2)}\n\`\`\``;
                    // We need to inject this into the stream so processCommands picks it up
                    // onChunk handles appending to the UI and fullResponse var
                    onChunk(syntheticJson, 'text');
                }
            }

        } catch (e) {
            if (e.message.includes("Rate limit") || e.message.includes("429")) {
                throw e;
            }
            throw e;
        }
    }

    async processCommands(text, aiDiv) {
        // Case insensitive match for both formatted versions
        const regex = /~~~json\s*([\s\S]*?)\s*~~~|```json\s*([\s\S]*?)\s*```/i;
        let match = text.match(regex);

        // Fallback: finding raw JSON { "actions": ... }
        if (!match) {
            // We look for the LAST occurrence of { "actions": to avoid matching "Here is an example: { "actions": ... }" earlier in text
            // But usually the tool call is at the end.
            const idx = text.lastIndexOf('{ "actions":');
            if (idx !== -1) {
                // Try to find the matching closing brace
                const jsonCandidate = text.substring(idx);
                // We need to support nested braces. Simple logic: count braces.
                let braceCount = 0;
                let endIndex = -1;
                let inString = false;

                // Heuristic: Just take everything to the end and hope JSON.parse fixes it or use the loop logic I wrote in streamWithBackoff
                // But let's reuse the simple substring logic from before but slightly improved
                match = [null, jsonCandidate];
            } else {
                // Fallback for weird format { update_file: ... }
                const altIdx = text.lastIndexOf('{ "update_file":');
                if (altIdx !== -1) match = [null, text.substring(altIdx)];
            }
        }

        if (match) {
            let jsonStr = match[1] || match[2] || match[0]; // match[0] if it was the raw fallback

            // Clean up markdown fences if they leaked into the capture group (unlikely with accurate regex but possible with wildcards)
            jsonStr = jsonStr.trim();
            if (jsonStr.startsWith('```json')) jsonStr = jsonStr.substring(7);
            if (jsonStr.startsWith('~~~json')) jsonStr = jsonStr.substring(7);
            if (jsonStr.endsWith('```')) jsonStr = jsonStr.substring(0, jsonStr.length - 3);
            if (jsonStr.endsWith('~~~')) jsonStr = jsonStr.substring(0, jsonStr.length - 3);

            try {
                // Sanitize: find the last '}' to strip trailing garbage if any
                const lb = jsonStr.lastIndexOf('}');
                if (lb !== -1) jsonStr = jsonStr.substring(0, lb + 1);

                // Try to handle the weird { tool: args } format wrapper
                // If it starts with { "toolname":
                let commandBlock = JSON.parse(jsonStr);

                // Normalization Logic
                if (!commandBlock.actions) {
                    // Check if root keys are actions
                    if (commandBlock.update_file) commandBlock = { actions: [{ type: 'update_file', ...commandBlock.update_file, path: commandBlock.update_file.filename || commandBlock.update_file.path }] };
                    else if (commandBlock.create_file) commandBlock = { actions: [{ type: 'create_file', ...commandBlock.create_file, path: commandBlock.create_file.filename || commandBlock.create_file.path }] };
                    // ... other types
                } else {
                    // Normalize actions array
                    commandBlock.actions = commandBlock.actions.map(a => {
                        // Check for { update_file: { ... } } inside actions array
                        const keys = Object.keys(a);
                        if (!a.type && keys.length === 1) {
                            const type = keys[0]; // e.g. "update_file"
                            const args = a[type];
                            return { type: type, path: args.filename || args.path || args.file, content: args.content, ...args };
                        }

                        // Map 'file' -> 'path' and 'operation' -> 'type' if needed
                        if (a.file && !a.path) a.path = a.file;
                        if (a.operation && !a.type) a.type = a.operation === 'create' ? 'create_file' : (a.operation === 'update' ? 'update_file' : a.operation);

                        return a;
                    });
                }

                if (commandBlock.actions) {
                    const working = aiDiv.querySelector('.ai-working');
                    if (working) working.remove();

                    for (const action of commandBlock.actions) {
                        // Double check path existence for validation
                        if (!action.path) action.path = action.filename || action.file;

                        if (!action.path && action.type !== 'create_file' && action.type !== 'create_folder') {
                            console.warn("Skipping action without path:", action);
                            continue;
                        }

                        if (action.type === 'read_file') {
                            this.appendActionCard(aiDiv, action, {});

                            const fileObj = await this.vfs.readFile(action.path || '');
                            const content = fileObj ? fileObj.content : "// Not found";

                            this.messages.push({
                                role: 'system',
                                content: `[Tool Result] ${action.path} Content:\n\`\`\`\n${content}\n\`\`\``
                            });

                            const separator = document.createElement('hr');
                            separator.style.borderColor = '#333';
                            separator.style.margin = '10px 0';
                            aiDiv.querySelector('.content').appendChild(separator);

                            await this.runAIStream(aiDiv);
                            return;

                        } else {
                            // Edits
                            let stats = { added: 0, removed: 0 };
                            // Normalize path again just in case
                            const p = action.path || action.filename;
                            if (!p) continue;

                            if (action.type === 'create_file') {
                                await this.vfs.createFile(p, action.content);
                                stats.added = (action.content || '').split('\n').length;
                            } else if (action.type === 'update_file') {
                                const oldContent = (await this.vfs.readFile(p))?.content || '';
                                await this.vfs.updateFile(p, action.content);
                                const oldLines = oldContent.split('\n');
                                const newLines = (action.content || '').split('\n');
                                const delta = newLines.length - oldLines.length;
                                if (delta > 0) { stats.added = delta; stats.removed = 0; }
                                else if (delta < 0) { stats.added = 0; stats.removed = Math.abs(delta); }
                                else { stats.added = 1; stats.removed = 1; }
                            } else if (action.type === 'delete_file') {
                                stats.removed = ((await this.vfs.readFile(p))?.content || '').split('\n').length;
                                await this.vfs.deleteNode(p);
                            } else if (action.type === 'create_folder') {
                                await this.vfs.createFolder(p);
                            }
                            this.appendActionCard(aiDiv, action, stats);
                        }
                    }

                    // Instant refresh
                    await this.uiMgr.refreshFileTree();
                    this.refreshEditor();
                }
            } catch (e) { console.error("JSON Error", e); }
        }
    }

    refreshEditor() {
        if (this.uiMgr.editorMgr.currentPath) {
            this.vfs.readFile(this.uiMgr.editorMgr.currentPath).then(f => {
                if (f) this.uiMgr.editorMgr.editor.setValue(f.content);
            });
        }
    }

    appendActionCard(container, action, stats) {
        const div = document.createElement('div');
        div.className = 'action-summary';
        div.setAttribute('data-type', action.type);

        // Safety: Ensure action.path is defined to prevent "Undefined reading split"
        const pathStr = action.path || 'unknown.txt';

        let typeLabel = "Edited";
        let statsHtml = '';

        if (action.type === 'read_file') {
            typeLabel = "Analyzed";
            statsHtml = `<div class="stats" style="color:#666">Read lines ${action.start_line || 1}-${action.end_line || 'end'}</div>`;
        } else {
            if (action.type === 'create_file') typeLabel = "Created";
            if (action.type === 'delete_file') typeLabel = "Deleted";
            if (action.type === 'create_folder') typeLabel = "Folder";

            if (action.type !== 'create_folder' && action.type !== 'delete_file') {
                statsHtml = `
                    <div class="stats">
                        ${stats.added > 0 ? `<span class="diff-add">+${stats.added}</span>` : ''}
                        ${stats.removed > 0 ? `<span class="diff-rem">-${stats.removed}</span>` : ''}
                        ${stats.added === 0 && stats.removed === 0 ? '<span class="diff-add">~</span>' : ''}
                    </div>
                `;
                // If no content change (0, 0), maybe show "Modified"
                if (stats.added === 0 && stats.removed === 0 && action.type === 'update_file') {
                    statsHtml = `<div class="stats"><span class="diff-add">~</span></div>`;
                }
            }
        }

        const fname = pathStr.split('/').pop();
        const ext = fname.split('.').pop();

        div.innerHTML = `
            <span class="type-label">${typeLabel}</span>
            <span class="ext ${ext}">${ext.toUpperCase()}</span>
            <span class="file-name">${fname}</span>
            ${statsHtml}
        `;

        // Ensure content div exists (it should)
        let contentDiv = container.querySelector('.content');
        if (!contentDiv) {
            container.appendChild(div);
        } else {
            contentDiv.appendChild(div);
        }
    }

    renderMarkdown(text) {
        let displayHtml = text;

        // Case insensitive regex
        const jsonMatch = text.match(/(\n\s*)?```json[\s\S]*$/i) || text.match(/(\n\s*)?~~~json[\s\S]*$/i);
        // Improved Complete Match: Find LAST occurrence to avoid greedily eating previous code blocks
        // We assume the tool call is typically at the end. 
        // But to be robust, let's strictly look for our specific tool signature if possible?
        // Simpler: Just use non-greedy matching global replace to hide ALL hidden JSON blocks?
        // Whatever the AI outputs as ```json ... ``` we assume is tool usage if it's not user code. 
        // But the AI might write "Here is a json: ```json {}```". 
        // We should check content. 
        // For now, let's adhere to "hide all tool json blocks".

        const jsonBlocks = [...text.matchAll(/```json\s*([\s\S]*?)\s*```/gi), ...text.matchAll(/~~~json\s*([\s\S]*?)\s*~~~/gi)];

        let workingIndicator = '';

        if (jsonMatch && !(jsonBlocks.length > 0 && text.endsWith('```'))) {
            // Processing in progress (open block at end)
            displayHtml = text.substring(0, jsonMatch.index);
            if (text.includes("update_file") || text.includes("create_file")) {
                workingIndicator = `<div class="ai-working"><i class="fa-solid fa-pen-to-square fa-spin"></i> Writing updates...</div>`;
            } else if (text.includes("read_file")) {
                workingIndicator = `<div class="ai-working"><i class="fa-solid fa-magnifying-glass fa-bounce"></i> Reading file...</div>`;
            } else {
                workingIndicator = `<div class="ai-working"><i class="fa-solid fa-gear fa-spin"></i> Processing...</div>`;
            }
        }

        // Remove completed JSON blocks that look like tool calls (contain "actions")
        // Or just remove all for now if we can't distinguish? 
        // User complained about "appearing".
        // Let's hide any block that contains "actions": [

        // Remove completed JSON blocks that look like tool calls (contain "actions")

        // 1. Remove Fenced Blocks
        displayHtml = displayHtml.replace(/```json\s*([\s\S]*?)\s*```/gi, (match, content) => {
            if (content.includes('"actions"') || content.includes('"update_file"') || content.includes('"read_file"')) return '';
            return match;
        });
        displayHtml = displayHtml.replace(/~~~json\s*([\s\S]*?)\s*~~~/gi, (match, content) => {
            if (content.includes('"actions"') || content.includes('"update_file"')) return '';
            return match;
        });

        // 2. Remove Raw JSON Blocks (aggressive)
        // Look for { "actions": [ ... ] } blocks even without fences
        // This is risky if user types it, but necessary if AI fails to fence
        displayHtml = displayHtml.replace(/{ "actions":\s*\[[\s\S]*?\]\s*}/gi, (match) => {
            return ''; // Hide it
        });

        let html = displayHtml
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^*]+)\*/g, '<em>$1</em>')
            .replace(/\n/g, '<br>');

        return html + workingIndicator;
    }
    setLoading(l) { this.sendBtn.disabled = l; }
}

// --- Bootstrap ---
document.addEventListener('DOMContentLoaded', () => {
    const vfs = new FileSystemHandler();
    vfs.loadVFS(); // Load VFS on start

    const editorMgr = new EditorManager(vfs);
    const chatMgr = new ChatManager(vfs, null);
    const uiMgr = new UIManager(vfs, editorMgr, chatMgr);
    chatMgr.uiMgr = uiMgr;

    // Init Preview
    new PreviewManager(vfs);
});
