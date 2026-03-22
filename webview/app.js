// ============================================
// Claude Code Mobile Bridge — Client App
// Vanilla JS, no frameworks. DOM-based rendering
// (no innerHTML) for XSS safety.
// ============================================

(function () {
  'use strict';

  // -- DOM Elements --
  const chatArea = document.getElementById('chatArea');
  const chatMessages = document.getElementById('chatMessages');
  const messageInput = document.getElementById('messageInput');
  const sendBtn = document.getElementById('sendBtn');
  const acceptBtn = document.getElementById('acceptBtn');
  const rejectBtn = document.getElementById('rejectBtn');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const scrollIndicator = document.getElementById('scrollIndicator');
  const scrollBtn = document.getElementById('scrollBtn');

  // -- State --
  let ws = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let isAtBottom = true;

  const MAX_RECONNECT_DELAY = 30000;
  const BASE_RECONNECT_DELAY = 1000;

  // =============================================
  // WebSocket
  // =============================================

  function getToken() {
    // Try URL first (initial QR scan), then localStorage (PWA home screen)
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      // Persist for PWA home screen launches
      try { localStorage.setItem('claude-mobile-token', urlToken); } catch {}
      return urlToken;
    }
    try { return localStorage.getItem('claude-mobile-token') || ''; } catch {}
    return '';
  }

  function getWsUrl() {
    const token = getToken();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    return protocol + '//' + host + '/ws?token=' + encodeURIComponent(token);
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    setConnectionStatus('connecting');

    try {
      ws = new WebSocket(getWsUrl());
    } catch (err) {
      setConnectionStatus('disconnected');
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      reconnectAttempt = 0;
      setConnectionStatus('connected');
      wsSend({ type: 'request_history' });
    };

    ws.onmessage = function (event) {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      handleMessage(msg);
    };

    ws.onclose = function () {
      setConnectionStatus('disconnected');
      scheduleReconnect();
    };

    ws.onerror = function () {
      setConnectionStatus('disconnected');
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(
      BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempt),
      MAX_RECONNECT_DELAY
    );
    reconnectAttempt++;
    setConnectionStatus('connecting');
    statusText.textContent = 'Reconnecting in ' + Math.round(delay / 1000) + 's...';
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function wsSend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  function setConnectionStatus(status) {
    statusDot.className = 'status-dot';
    if (status === 'connected') {
      statusDot.classList.add('connected');
      statusText.textContent = 'Connected';
    } else if (status === 'connecting') {
      statusDot.classList.add('connecting');
      statusText.textContent = 'Connecting...';
    } else {
      statusText.textContent = 'Disconnected';
    }
  }

  // =============================================
  // Message Handling
  // =============================================

  function handleMessage(msg) {
    if (msg.type === 'history') {
      renderHistory(msg.data);
    } else if (msg.type === 'chat_message') {
      appendMessage(msg.data);
    }
    // 'connection_status' — handled via ws events
  }

  function renderHistory(messages) {
    chatMessages.textContent = '';
    if (!Array.isArray(messages)) return;
    messages.forEach(function (m) {
      appendMessage(m, true);
    });
    scrollToBottom(true);
  }

  function appendMessage(msg, skipScroll) {
    if (!msg) return;
    const wasAtBottom = isAtBottom;

    let el;
    if (msg.type === 'tool_call') {
      el = createToolCallCard(msg);
    } else if (msg.type === 'tool_result') {
      el = createToolResultCard(msg);
    } else {
      el = createMessageBubble(msg);
    }

    chatMessages.appendChild(el);

    if (!skipScroll) {
      if (wasAtBottom) {
        scrollToBottom();
      } else {
        showScrollIndicator();
      }
    }
  }

  // =============================================
  // Message Bubble
  // =============================================

  function createMessageBubble(msg) {
    const div = document.createElement('div');
    div.className = 'message ' + (msg.type || 'assistant');
    div.dataset.id = msg.id || '';

    if (msg.type !== 'status') {
      const meta = document.createElement('div');
      meta.className = 'message-meta';

      const role = document.createElement('span');
      role.className = 'message-role';
      role.textContent = msg.type === 'user' ? 'You' : 'Claude';
      meta.appendChild(role);

      if (msg.timestamp) {
        const time = document.createElement('span');
        time.className = 'message-time';
        time.textContent = formatTime(msg.timestamp);
        meta.appendChild(time);
      }

      div.appendChild(meta);
    }

    const content = document.createElement('div');
    content.className = 'message-content';
    renderMarkdownInto(content, msg.content || '');
    div.appendChild(content);

    return div;
  }

  // =============================================
  // Tool Cards
  // =============================================

  function createToolCallCard(msg) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.id = msg.id || '';

    const header = document.createElement('div');
    header.className = 'tool-card-header';
    header.appendChild(createChevronSvg());

    const badge = document.createElement('span');
    badge.className = 'tool-badge';
    badge.appendChild(createToolIconSvg());
    badge.appendChild(document.createTextNode(msg.toolName || 'tool'));
    header.appendChild(badge);

    const summary = document.createElement('span');
    summary.className = 'tool-card-summary';
    summary.textContent = getToolSummary(msg);
    header.appendChild(summary);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'tool-card-body';
    const pre = document.createElement('pre');
    pre.textContent = msg.toolInput
      ? JSON.stringify(msg.toolInput, null, 2)
      : (msg.content || '');
    body.appendChild(pre);
    card.appendChild(body);

    header.addEventListener('click', function () {
      card.classList.toggle('expanded');
      triggerHaptic();
    });

    return card;
  }

  function createToolResultCard(msg) {
    const card = document.createElement('div');
    card.className = 'tool-card' + (msg.isError ? ' error' : '');
    card.dataset.id = msg.id || '';

    const header = document.createElement('div');
    header.className = 'tool-card-header';
    header.appendChild(createChevronSvg());

    const badge = document.createElement('span');
    badge.className = 'tool-badge';
    badge.textContent = msg.isError ? 'Error' : 'Result';
    header.appendChild(badge);

    const summary = document.createElement('span');
    summary.className = 'tool-card-summary';
    const preview = (msg.content || '').substring(0, 80);
    summary.textContent = preview + (msg.content && msg.content.length > 80 ? '...' : '');
    header.appendChild(summary);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'tool-card-body';
    const pre = document.createElement('pre');
    pre.textContent = msg.content || '';
    body.appendChild(pre);
    card.appendChild(body);

    header.addEventListener('click', function () {
      card.classList.toggle('expanded');
      triggerHaptic();
    });

    return card;
  }

  // =============================================
  // SVG Helpers
  // =============================================

  function createChevronSvg() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'tool-card-chevron');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS(ns, 'polyline');
    path.setAttribute('points', '9 18 15 12 9 6');
    svg.appendChild(path);
    return svg;
  }

  function createToolIconSvg() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'tool-badge-icon');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z');
    svg.appendChild(path);
    return svg;
  }

  function getToolSummary(msg) {
    if (!msg.toolInput) return '';
    const input = msg.toolInput;
    const lookupKeys = ['command', 'file_path', 'query', 'pattern', 'url', 'path'];
    for (let i = 0; i < lookupKeys.length; i++) {
      if (input[lookupKeys[i]]) return truncate(String(input[lookupKeys[i]]), 60);
    }
    const keys = Object.keys(input);
    for (let i = 0; i < keys.length; i++) {
      const val = input[keys[i]];
      if (typeof val === 'string' && val.length > 0) return truncate(val, 60);
    }
    return '';
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '...' : str;
  }

  // =============================================
  // Markdown Rendering (safe, DOM-based)
  //
  // All content is rendered via DOM API methods
  // (createElement, textContent, etc.) — no raw
  // HTML string injection. URLs are sanitized to
  // only allow http/https protocols.
  // =============================================

  function renderMarkdownInto(container, text) {
    if (!text) return;

    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      const before = text.substring(lastIndex, match.index);
      if (before) appendInlineContent(container, before);

      const pre = document.createElement('pre');
      if (match[1]) {
        const hdr = document.createElement('div');
        hdr.className = 'code-header';
        hdr.textContent = match[1];
        pre.appendChild(hdr);
      }
      const codeEl = document.createElement('code');
      codeEl.textContent = match[2];
      pre.appendChild(codeEl);
      container.appendChild(pre);

      lastIndex = match.index + match[0].length;
    }

    const remaining = text.substring(lastIndex);
    if (remaining) appendInlineContent(container, remaining);
  }

  function appendInlineContent(container, text) {
    const paragraphs = text.split(/\n{2,}/);
    paragraphs.forEach(function (paraText) {
      paraText = paraText.trim();
      if (!paraText) return;
      const p = document.createElement('p');
      renderInlineTokens(p, paraText);
      container.appendChild(p);
    });
  }

  function renderInlineTokens(parent, text) {
    // Regex for inline tokens: code, bold, italic, md links, bare urls, newlines
    const tokenRegex = /(`[^`\n]+`)|(\*\*[^*]+\*\*)|(?<!\*)\*([^*\n]+)\*(?!\*)|(\[[^\]]+\]\([^)]+\))|(https?:\/\/[^\s<)]+)|(\n)/g;
    let lastIdx = 0;
    let m;

    while ((m = tokenRegex.exec(text)) !== null) {
      if (m.index > lastIdx) {
        parent.appendChild(document.createTextNode(text.substring(lastIdx, m.index)));
      }

      if (m[1]) {
        // Inline code
        const code = document.createElement('code');
        code.textContent = m[1].substring(1, m[1].length - 1);
        parent.appendChild(code);
      } else if (m[2]) {
        // Bold
        const strong = document.createElement('strong');
        strong.textContent = m[2].substring(2, m[2].length - 2);
        parent.appendChild(strong);
      } else if (m[3]) {
        // Italic
        const em = document.createElement('em');
        em.textContent = m[3];
        parent.appendChild(em);
      } else if (m[4]) {
        // Markdown link
        const linkParts = m[4].match(/\[([^\]]+)\]\(([^)]+)\)/);
        if (linkParts) {
          const a = document.createElement('a');
          a.href = sanitizeUrl(linkParts[2]);
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = linkParts[1];
          parent.appendChild(a);
        }
      } else if (m[5]) {
        // Bare URL
        const a = document.createElement('a');
        a.href = sanitizeUrl(m[5]);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = m[5];
        parent.appendChild(a);
      } else if (m[6]) {
        // Newline
        parent.appendChild(document.createElement('br'));
      }

      lastIdx = m.index + m[0].length;
    }

    if (lastIdx < text.length) {
      parent.appendChild(document.createTextNode(text.substring(lastIdx)));
    }
  }

  function sanitizeUrl(url) {
    if (!url) return '#';
    const trimmed = url.trim().toLowerCase();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return url.trim();
    }
    return '#';
  }

  // =============================================
  // Input Handling
  // =============================================

  function initInput() {
    messageInput.addEventListener('input', function () {
      autoGrow(this);
      sendBtn.disabled = !this.value.trim();
    });

    messageInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    sendBtn.addEventListener('click', function () {
      sendMessage();
    });

    acceptBtn.addEventListener('click', function () {
      triggerHaptic();
      acceptBtn.classList.add('press-animate');
      setTimeout(function () { acceptBtn.classList.remove('press-animate'); }, 150);
      wsSend({ type: 'accept' });
    });

    rejectBtn.addEventListener('click', function () {
      triggerHaptic();
      rejectBtn.classList.add('press-animate');
      setTimeout(function () { rejectBtn.classList.remove('press-animate'); }, 150);
      wsSend({ type: 'reject' });
    });

    scrollBtn.addEventListener('click', function () {
      scrollToBottom();
      hideScrollIndicator();
    });
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    const maxH = parseFloat(getComputedStyle(el).maxHeight) || 200;
    el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
  }

  function sendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;
    if (!wsSend({ type: 'send_message', text: text })) return;

    messageInput.value = '';
    messageInput.style.height = 'auto';
    sendBtn.disabled = true;
    messageInput.focus();
  }

  // =============================================
  // Scroll Management
  // =============================================

  function initScroll() {
    chatArea.addEventListener('scroll', function () {
      isAtBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < 80;
      if (isAtBottom) hideScrollIndicator();
    }, { passive: true });
  }

  function scrollToBottom(instant) {
    requestAnimationFrame(function () {
      chatArea.scrollTo({
        top: chatArea.scrollHeight,
        behavior: instant ? 'auto' : 'smooth'
      });
      isAtBottom = true;
      hideScrollIndicator();
    });
  }

  function showScrollIndicator() {
    scrollIndicator.hidden = false;
  }

  function hideScrollIndicator() {
    scrollIndicator.hidden = true;
  }

  // =============================================
  // Utilities
  // =============================================

  function formatTime(timestamp) {
    try {
      const d = new Date(timestamp);
      if (isNaN(d.getTime())) return '';
      return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    } catch (e) {
      return '';
    }
  }

  function triggerHaptic() {
    if (navigator.vibrate) navigator.vibrate(50);
  }

  // =============================================
  // iOS Keyboard Handling
  // =============================================

  function initKeyboardHandling() {
    if (window.visualViewport) {
      const onViewportChange = function () {
        const viewport = window.visualViewport;
        const bottomOffset = window.innerHeight - viewport.height - viewport.offsetTop;
        const inputArea = document.getElementById('inputArea');
        const actionBar = document.getElementById('actionBar');
        if (bottomOffset > 50) {
          inputArea.style.paddingBottom = '8px';
          inputArea.style.bottom = bottomOffset + 'px';
          actionBar.style.bottom = (bottomOffset + 58) + 'px';
        } else {
          inputArea.style.paddingBottom = '';
          inputArea.style.bottom = '';
          actionBar.style.bottom = '';
        }
      };
      window.visualViewport.addEventListener('resize', onViewportChange);
      window.visualViewport.addEventListener('scroll', onViewportChange);
    }
  }

  // =============================================
  // Init
  // =============================================

  function init() {
    initInput();
    initScroll();
    initKeyboardHandling();
    connect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
