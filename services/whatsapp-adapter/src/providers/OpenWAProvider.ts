// services/whatsapp-adapter/src/providers/OpenWAProvider.ts
//
// Persistent WhatsApp Web / OpenWA Transport Adapter.
// Manages real Chromium browser lifecycle, authentic WhatsApp Web pairing QR extraction,
// session persistence across restarts, and ERP ingress/outbound messaging.

import {
  WhatsAppProvider,
  WhatsAppConnectionStatus,
  WhatsAppSendResult,
  WhatsAppInboundMessage,
  WhatsAppConnectionState,
} from './WhatsAppProvider';

import puppeteer, { Browser, Page } from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';

export interface OpenWAProviderConfig {
  sessionId?: string;
  erpIngressUrl: string;
  webhookSecret: string;
  businessPhone?: string;
  sessionDataPath?: string;
  headless?: boolean;
  mockMode?: boolean;
}

export class OpenWAProvider implements WhatsAppProvider {
  private config: OpenWAProviderConfig;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private status: WhatsAppConnectionState = 'unpaired';
  private qrCode: string | null = null;
  private lastSeen: string = new Date().toISOString();
  private lastError?: string;
  private monitorInterval: NodeJS.Timeout | null = null;
  private isInitializing: boolean = false;
  private lastDiagnosticTime: number = 0;
  private authenticatedPhone: string | null = null;
  private authenticatedJid: string | null = null;
  private identityVerifiedAt: string | null = null;
  private identitySource: string | null = null;

  constructor(config: OpenWAProviderConfig) {
    const isMock = process.env.MOCK_MODE === 'true';
    const baseSessionPath = process.env.SESSION_DATA_PATH || './_sessions';
    const resolvedSessionPath = path.isAbsolute(baseSessionPath)
      ? baseSessionPath
      : path.resolve(process.cwd(), baseSessionPath);

    this.config = {
      sessionId: process.env.SESSION_ID || config.sessionId || 'sapj-business-whatsapp',
      headless: process.env.HEADLESS !== 'false',
      businessPhone: process.env.BUSINESS_PHONE || config.businessPhone,
      sessionDataPath: resolvedSessionPath,
      mockMode: isMock,
      ...config,
    };
  }

  public isMock(): boolean {
    return !!this.config.mockMode;
  }

  /**
   * Discovers the Chrome or Chromium binary on the system
   */
  private findChromePath(): string {
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
      return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
      return process.env.CHROME_BIN;
    }

    const candidatePaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    throw new Error('Chromium/Chrome binary not found. Set PUPPETEER_EXECUTABLE_PATH or CHROME_BIN.');
  }

  public async initialize(): Promise<void> {
    if (this.isInitializing) return;
    this.isInitializing = true;

    if (this.config.mockMode) {
      console.log('[OpenWAProvider] Running in MOCK SIMULATION mode.');
      await this.generateMockQr();
      this.lastSeen = new Date().toISOString();
      this.isInitializing = false;
      return;
    }

    try {
      const chromePath = this.findChromePath();
      const sessionDir = path.join(this.config.sessionDataPath || './_sessions', this.config.sessionId || 'sapj-business-whatsapp');

      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      } else {
        // Clean up any stale Chromium lock files if previous process exited abruptly
        for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
          const lockPath = path.join(sessionDir, lock);
          if (fs.existsSync(lockPath)) {
            try {
              fs.unlinkSync(lockPath);
              console.log(`[OpenWAProvider] Cleaned stale lock: ${lock}`);
            } catch (e) {}
          }
        }
      }

      console.log(`[OpenWAProvider] Launching Chromium with session '${this.config.sessionId}'...`);
      console.log(`[OpenWAProvider] Session storage: ${sessionDir}`);

      this.browser = await puppeteer.launch({
        executablePath: chromePath,
        userDataDir: sessionDir,
        headless: this.config.headless !== false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-zygote',
        ],
      });

      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1366, height: 900 });
      await this.page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
      );

      // Expose incoming message receiver to page
      await this.page.exposeFunction('onInboundWhatsAppMessageBridge', async (payloadStr: string) => {
        try {
          const payload = JSON.parse(payloadStr) as WhatsAppInboundMessage;
          console.log(`[OpenWAProvider] Inbound WhatsApp message received from ${payload.senderPhone}`);
          await this.forwardInboundToErp(payload);
        } catch (e: any) {
          console.error('[OpenWAProvider] Error processing inbound bridge payload:', e);
        }
      });

      console.log('[OpenWAProvider] Navigating to https://web.whatsapp.com ...');
      await this.page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Begin session monitoring
      this.startSessionMonitor();
    } catch (err: any) {
      console.error('[OpenWAProvider] Initialization error:', err.message);
      this.status = 'error';
      this.lastError = err.message;
      this.lastSeen = new Date().toISOString();
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Monitors the WhatsApp Web page to extract real authentic QR or detect authenticated chat list
   */
  private startSessionMonitor(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }

    this.monitorInterval = setInterval(async () => {
      if (!this.page || this.page.isClosed()) return;

      try {
        // 1. Check if authenticated (chat list container exists)
        const isAuth = await this.page.evaluate(() => {
          return !!(
            document.querySelector('#pane-side') ||
            document.querySelector('[data-testid="chat-list"]') ||
            document.querySelector('div[aria-label="Chat list"]')
          );
        });

        if (isAuth) {
          if (this.status !== 'connected') {
            console.log('[OpenWAProvider] WhatsApp Business session AUTHENTICATED & CONNECTED!');
            this.status = 'connected';
            this.qrCode = null;
            this.lastError = undefined;
            this.lastSeen = new Date().toISOString();

            // Extract real authenticated WhatsApp Business session identity
            await this.extractSessionIdentity();

            // Inject inbound message observer into WhatsApp Web
            await this.injectInboundObserver();
          } else if (!this.authenticatedPhone) {
            await this.extractSessionIdentity();
          }
          return;
        }

        // 2. Check for Click-To-Reload QR Button (when QR expires after 20-30s)
        const reloaded = await this.page
          .evaluate(() => {
            const reloadSpan = document.querySelector('span[data-icon="refresh"]');
            if (reloadSpan) {
              const btn = reloadSpan.closest('button, div[role="button"]') || reloadSpan;
              (btn as HTMLElement).click();
              return true;
            }
            const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
            for (const b of buttons) {
              const text = (b.textContent || '').toLowerCase();
              if (text.includes('reload') || text.includes('muat ulang') || text.includes('click to reload')) {
                (b as HTMLElement).click();
                return true;
              }
            }
            return false;
          })
          .catch(() => false);

        if (reloaded) {
          console.log('[OpenWAProvider] Clicked WhatsApp Web QR reload button. Refreshing canvas...');
          await new Promise((r) => setTimeout(r, 1200));
        }

        // 3. Check for real QR Code Canvas (supports all WhatsApp Web DOM variations)
        const qrCanvas = await this.page.$('canvas[aria-label], div[data-ref] canvas, canvas');
        if (qrCanvas) {
          const qrDataUrl = await this.page.evaluate((c: any) => {
            if (c && c.width > 50 && c.height > 50) {
              return c.toDataURL('image/png');
            }
            return null;
          }, qrCanvas);
          if (qrDataUrl && qrDataUrl.startsWith('data:image/png;base64,')) {
            if (this.status !== 'unpaired' || this.qrCode !== qrDataUrl) {
              this.qrCode = qrDataUrl;
              this.status = 'unpaired';
              this.lastSeen = new Date().toISOString();
              console.log('[OpenWAProvider] Authentic WhatsApp Web pairing QR code ready.');
            }
            return;
          }
        }

        // Diagnostic heartbeat every ~10s
        const now = Date.now();
        if (!this.lastDiagnosticTime || now - this.lastDiagnosticTime > 10000) {
          this.lastDiagnosticTime = now;
          const diag = await this.page.evaluate(() => {
            const canvasEl = document.querySelector('canvas');
            const spinner = !!document.querySelector('[data-testid="loading-spinner"]');
            const intro = !!document.querySelector('[data-testid="intro-title"], [data-testid="intro-md-beta-logo-dark"]');
            return {
              title: document.title,
              hasCanvas: !!canvasEl,
              canvasSize: canvasEl ? `${canvasEl.width}x${canvasEl.height}` : null,
              hasSpinner: spinner,
              hasIntro: intro,
              bodyText: (document.body ? document.body.innerText : '').slice(0, 100).replace(/\s+/g, ' '),
            };
          }).catch((err) => ({ error: err.message }));
          console.log('[OpenWAProvider] Diagnostic DOM status:', JSON.stringify(diag));
        }
      } catch (err: any) {
        // Suppress benign context destroyed or detached frame errors during navigation
        if (
          !err.message?.includes('Execution context was destroyed') &&
          !err.message?.includes('detached Frame') &&
          !err.message?.includes('Target closed')
        ) {
          this.lastError = err.message;
        }
      }
    }, 2000);
  }

  /**
   * Retrieves the authenticated account's actual WhatsApp number/JID directly from the runtime transport.
   * Direct inspection of WAWebUserPrefsMeUser / localStorage in the active page context.
   */
  public async extractSessionIdentity(): Promise<{
    phone: string | null;
    jid: string | null;
    source: string | null;
    verifiedAt: string | null;
  }> {
    if (!this.page || this.page.isClosed()) {
      return {
        phone: this.authenticatedPhone,
        jid: this.authenticatedJid,
        source: this.identitySource,
        verifiedAt: this.identityVerifiedAt,
      };
    }

    try {
      const identity = await this.page.evaluate(() => {
        try {
          // 1. Primary: WhatsApp Web internal session API (WAWebUserPrefsMeUser)
          // @ts-ignore
          if (typeof window.require === 'function') {
            try {
              // @ts-ignore
              const meMod = window.require('WAWebUserPrefsMeUser');
              if (meMod && typeof meMod.getMaybeMePnUser === 'function') {
                const pn = meMod.getMaybeMePnUser();
                if (pn && pn.user) {
                  const clean = String(pn.user).replace(/\D/g, '');
                  if (clean) {
                    return {
                      phone: `+${clean}`,
                      jid: pn._serialized || `${clean}@c.us`,
                      source: 'WAWebUserPrefsMeUser.getMaybeMePnUser()',
                    };
                  }
                }
              }
            } catch (e) {}
          }

          // 2. Secondary fallback: localStorage (last-wid-md or last-wid)
          const rawWid = localStorage.getItem('last-wid-md') || localStorage.getItem('last-wid');
          if (rawWid) {
            const unquoted = typeof rawWid === 'string' ? rawWid.replace(/^"|"$/g, '') : '';
            const match = unquoted.match(/^(\d+)/);
            if (match && match[1]) {
              return {
                phone: `+${match[1]}`,
                jid: `${match[1]}@c.us`,
                source: 'localStorage.last-wid-md',
              };
            }
          }
        } catch (e) {}
        return null;
      });

      if (identity && identity.phone) {
        this.authenticatedPhone = identity.phone;
        this.authenticatedJid = identity.jid;
        this.identitySource = identity.source;
        this.identityVerifiedAt = new Date().toISOString();
        console.log(`[OpenWAProvider] Runtime session identity detected: ${this.authenticatedPhone} via ${this.identitySource}`);
      }
    } catch (err: any) {
      console.warn('[OpenWAProvider] Error extracting session identity:', err.message);
    }

    return {
      phone: this.authenticatedPhone,
      jid: this.authenticatedJid,
      source: this.identitySource,
      verifiedAt: this.identityVerifiedAt,
    };
  }

  /**
   * Injects an observer to capture incoming messages from WhatsApp Web (MsgCollection + DOM fallback)
   */
  private async injectInboundObserver(): Promise<void> {
    if (!this.page || this.page.isClosed()) return;

    try {
      await this.page.evaluate(() => {
        // @ts-ignore
        if (window.__anzenWaObserverInstalled) return;
        // @ts-ignore
        window.__anzenWaObserverInstalled = true;

        // 1. Hook into WhatsApp Web internal MsgCollection if available
        try {
          // @ts-ignore
          if (typeof window.require === 'function') {
            // @ts-ignore
            const msgColMod = window.require('WAWebMsgCollection');
            const msgCol = msgColMod?.MsgCollection;
            if (msgCol && typeof msgCol.on === 'function') {
              msgCol.on('add', (msg: any) => {
                try {
                  if (!msg || msg.fromMe) return;

                  let senderPhone = '';
                  let senderName = '';
                  const chat = msg.chat;

                  if (chat) {
                    if (chat.formattedTitle && /\d/.test(chat.formattedTitle)) {
                      senderPhone = '+' + chat.formattedTitle.replace(/\D/g, '');
                    } else if (chat.contact && chat.contact.phoneNumber) {
                      senderPhone = '+' + String(chat.contact.phoneNumber).replace(/\D/g, '');
                    }
                    senderName = chat.contact?.pushname || chat.contact?.name || chat.formattedTitle || '';
                  }

                  if (!senderPhone && msg.from?._serialized) {
                    const match = msg.from._serialized.match(/^(\d+)/);
                    if (match) senderPhone = '+' + match[1];
                  }

                  const text = msg.body || msg.caption || '';
                  if (!text && !msg.type) return;

                  const messageId = msg.id?._serialized || `wa_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
                  const chatId = msg.from?._serialized || chat?.id?._serialized || (senderPhone ? `${senderPhone.replace(/\D/g, '')}@c.us` : 'unknown@c.us');

                  const payload = {
                    messageId,
                    chatId,
                    senderPhone: senderPhone || '+628000000000',
                    senderName: senderName || 'WhatsApp Contact',
                    text,
                    receivedAt: msg.t ? new Date(msg.t * 1000).toISOString() : new Date().toISOString(),
                    isGroup: msg.isGroupMsg || false,
                  };

                  // @ts-ignore
                  window.onInboundWhatsAppMessageBridge?.(JSON.stringify(payload));
                } catch (err) {
                  console.error('[WhatsApp Observer] Error handling MsgCollection event:', err);
                }
              });
              console.log('[Anzen Observer] WhatsApp Web MsgCollection listener attached.');
            }
          }
        } catch (e) {
          console.warn('[Anzen Observer] Could not attach to MsgCollection:', e);
        }

        // 2. Secondary fallback: MutationObserver for DOM message rows
        const observer = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const node of Array.from(m.addedNodes)) {
              if (node instanceof HTMLElement) {
                const msgRow = node.closest('[data-testid="msg-container"]') || node.querySelector('[data-testid="msg-container"]');
                if (msgRow) {
                  const isIncoming = msgRow.classList.contains('message-in') || msgRow.closest('.message-in');
                  if (isIncoming) {
                    const textEl = msgRow.querySelector('.selectable-text, [data-testid="selectable-text"]');
                    const text = textEl ? textEl.textContent?.trim() : '';

                    // Resolve chat header title
                    const chatHeaderTitle = document.querySelector('#main header [title]')?.getAttribute('title') || '';
                    const cleanPhone = chatHeaderTitle.replace(/\D/g, '');
                    const senderPhone = cleanPhone ? `+${cleanPhone}` : '+628000000000';

                    const messageId = `wa_dom_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
                    const payload = {
                      messageId,
                      chatId: `${senderPhone.replace(/\D/g, '')}@c.us`,
                      senderPhone,
                      senderName: chatHeaderTitle || 'WhatsApp Contact',
                      text: text || '',
                      receivedAt: new Date().toISOString(),
                    };

                    // @ts-ignore
                    window.onInboundWhatsAppMessageBridge?.(JSON.stringify(payload));
                  }
                }
              }
            }
          }
        });

        const target = document.querySelector('#main') || document.body;
        observer.observe(target, { childList: true, subtree: true });
        console.log('[Anzen Observer] WhatsApp Web DOM observer installed.');
      });
    } catch (e: any) {
      console.warn('[OpenWAProvider] Inbound observer injection warning:', e.message);
    }
  }

  public async connect(): Promise<WhatsAppConnectionStatus> {
    this.lastError = undefined;
    if (this.status === 'connected') {
      return this.getStatus();
    }
    this.status = 'unpaired';
    if (!this.browser || !this.page || this.page.isClosed()) {
      this.initialize().catch((err) => {
        console.error('[OpenWAProvider] initialize error during connect():', err.message);
      });
    }
    return this.getStatus();
  }

  public async disconnect(): Promise<WhatsAppConnectionStatus> {
    this.lastError = undefined;
    try {
      if (this.monitorInterval) {
        clearInterval(this.monitorInterval);
        this.monitorInterval = null;
      }
      if (this.page && !this.page.isClosed()) {
        await this.page.close().catch(() => {});
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
      }
    } catch (e: any) {
      console.warn('[OpenWAProvider] Error during browser close:', e.message);
    }
    this.browser = null;
    this.page = null;
    this.status = 'disconnected';
    this.qrCode = null;
    this.lastSeen = new Date().toISOString();
    return this.getStatus();
  }

  private async generateMockQr(): Promise<string> {
    const qrPayload = `OPENWA_SAPJ_SESSION:${this.config.sessionId}:${Date.now()}:${Math.random().toString(36).substring(2, 9)}`;
    const dataUrl = await QRCode.toDataURL(qrPayload, {
      width: 256,
      margin: 2,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    });
    this.qrCode = dataUrl;
    this.status = 'unpaired';
    return dataUrl;
  }

  public async refreshQr(): Promise<WhatsAppConnectionStatus> {
    if (this.status === 'connected') {
      return this.getStatus();
    }

    if (this.config.mockMode) {
      await this.generateMockQr();
      this.lastSeen = new Date().toISOString();
      return this.getStatus();
    }

    if (this.page && !this.page.isClosed()) {
      try {
        console.log('[OpenWAProvider] Forcing page reload to generate fresh WhatsApp Web QR...');
        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e: any) {
        console.warn('[OpenWAProvider] Reload error:', e.message);
      }
    } else {
      await this.initialize();
    }

    return this.getStatus();
  }

  public async pair(phone?: string): Promise<WhatsAppConnectionStatus> {
    this.status = 'connected';
    this.qrCode = null;
    this.lastError = undefined;
    this.lastSeen = new Date().toISOString();
    await this.extractSessionIdentity();
    console.log(`[OpenWAProvider] WhatsApp Business paired/connected for ${this.authenticatedPhone || phone || 'live-session'}`);
    return this.getStatus();
  }

  public async sendMessage(
    to: string,
    text: string,
    options?: Record<string, unknown>
  ): Promise<WhatsAppSendResult> {
    const timestamp = new Date().toISOString();

    if (this.status !== 'connected') {
      return {
        success: false,
        messageId: '',
        timestamp,
        error: `WhatsApp Business session is not connected (${this.status.toUpperCase()}). Pair via QR code first.`,
      };
    }

    const cleanDigits = to.replace(/\D/g, '');

    const isAuth = this.page
      ? await this.page
          .evaluate(() => {
            return !!(
              document.querySelector('#pane-side') ||
              document.querySelector('[data-testid="chat-list"]') ||
              document.querySelector('div[aria-label="Chat list"]')
            );
          })
          .catch(() => false)
      : false;

    if (this.config.mockMode) {
      this.lastSeen = timestamp;
      return {
        success: false,
        messageId: '',
        timestamp,
        error: 'Simulation mode active: outbound live WhatsApp sending disabled. Use connected WhatsApp Business session.',
      };
    }

    if (!this.page || !isAuth) {
      return {
        success: false,
        messageId: '',
        timestamp,
        error: 'WhatsApp Business session is not authenticated in browser. Scan QR code to connect.',
      };
    }

    let tempFilePath: string | null = null;
    try {
      const rawMediaUrl =
        (options?.documentUrl as string) ||
        (options?.imageUrl as string) ||
        (options?.mediaUrl as string) ||
        '';
      const fn = (options?.filename as string) || (options?.imageUrl ? 'image.jpg' : 'attachment.pdf');
      const caption = ((options?.caption as string) || text || '').trim();

      if (rawMediaUrl) {
        // Enforce WhatsApp provider caption limit (1024 characters for media messages)
        if (caption.length > 1024) {
          throw new Error(
            `WhatsApp limits media captions to 1024 characters (current: ${caption.length}). Please shorten the message.`
          );
        }

        // 1. Resolve and validate attachment
        const cleanFn = fn.replace(/[^a-zA-Z0-9._-]/g, '_');
        tempFilePath = path.join('/tmp', `wa_dispatch_${Date.now()}_${cleanFn}`);

        let resolvedMime = (options?.contentType as string) || (options?.mimeType as string) || '';
        let fileSizeBytes = 0;

        if (rawMediaUrl.startsWith('data:')) {
          const match = rawMediaUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (!match) throw new Error('Invalid Data URL attachment format');
          resolvedMime = resolvedMime || match[1];
          const buf = Buffer.from(match[2], 'base64');
          fileSizeBytes = buf.length;
          fs.writeFileSync(tempFilePath, buf);
        } else if (/^https?:\/\//i.test(rawMediaUrl)) {
          const dlRes = await fetch(rawMediaUrl);
          if (!dlRes.ok) {
            throw new Error(`Failed to download attachment from storage: HTTP ${dlRes.status} ${dlRes.statusText}`);
          }
          const serverMime = dlRes.headers.get('content-type') || '';
          if (!resolvedMime && serverMime && !serverMime.includes('octet-stream')) {
            resolvedMime = serverMime.split(';')[0].trim();
          }
          const arrayBuf = await dlRes.arrayBuffer();
          fileSizeBytes = arrayBuf.byteLength;
          fs.writeFileSync(tempFilePath, Buffer.from(arrayBuf));
        } else if (fs.existsSync(rawMediaUrl)) {
          const stat = fs.statSync(rawMediaUrl);
          fileSizeBytes = stat.size;
          fs.copyFileSync(rawMediaUrl, tempFilePath);
        } else {
          throw new Error(`Unsupported media attachment source or file not found`);
        }

        // Validate file size
        if (fileSizeBytes === 0) {
          throw new Error('Attachment file is empty (0 bytes)');
        }
        if (fileSizeBytes > 50 * 1024 * 1024) {
          throw new Error(`Attachment exceeds WhatsApp 50MB limit (${(fileSizeBytes / (1024 * 1024)).toFixed(1)}MB)`);
        }

        // Infer MIME if not resolved
        if (!resolvedMime) {
          if (/\.jpe?g$/i.test(cleanFn)) resolvedMime = 'image/jpeg';
          else if (/\.png$/i.test(cleanFn)) resolvedMime = 'image/png';
          else if (/\.webp$/i.test(cleanFn)) resolvedMime = 'image/webp';
          else if (/\.pdf$/i.test(cleanFn)) resolvedMime = 'application/pdf';
          else resolvedMime = 'application/octet-stream';
        }

        const isImage = Boolean(options?.imageUrl) || resolvedMime.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(cleanFn);
        console.log(`[OpenWAProvider] Media verified: MIME=${resolvedMime}, size=${fileSizeBytes} bytes, fn=${cleanFn}, isImage=${isImage}`);

        // 2. Open chat if not already active
        const isAlreadyOpen = await this.page.evaluate((digits: string) => {
          const main = document.querySelector('#main');
          if (!main) return false;
          try {
            const req = (window as any).require;
            const activeChat = req('WAWebChatNavState')?.getActiveChat?.();
            if (activeChat?.id?.user === digits) return true;
          } catch (e) {}
          const header = main.querySelector('header')?.textContent || '';
          return header.includes(digits);
        }, cleanDigits);

        if (!isAlreadyOpen) {
          let openedViaAction = false;
          try {
            openedViaAction = await this.page.evaluate(async (digits: string) => {
              const req = (window as any).require;
              if (!req) return false;
              const wf = req('WAWebWidFactory');
              const wid = wf.createWid(`${digits}@c.us`);
              const nav = req('WAWebOpenChatWithContactAction');
              if (nav?.openChatWithContact) {
                await nav.openChatWithContact({ targetId: wid });
                return true;
              }
              return false;
            }, cleanDigits);
          } catch (e) {}

          if (!openedViaAction) {
            const sendUrl = `https://web.whatsapp.com/send?phone=${cleanDigits}`;
            console.log(`[OpenWAProvider] Navigating to chat via URL for ${cleanDigits}...`);
            await this.page.goto(sendUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
          }
        }

        // Check for invalid phone popup modal
        const invalidPopupText = await this.page.evaluate(() => {
          const modal = document.querySelector(
            '[data-animate-modal-popup="true"], [data-testid="confirm-popup"], div[role="dialog"]'
          );
          if (modal) {
            const body = (modal.textContent || '').trim();
            if (
              body.includes('phone number shared via url is invalid') ||
              body.includes("isn't on WhatsApp") ||
              body.includes('tidak terdaftar')
            ) {
              const okBtn = modal.querySelector('button, div[role="button"]');
              if (okBtn) (okBtn as HTMLElement).click();
              return body;
            }
          }
          return null;
        });

        if (invalidPopupText) {
          throw new Error(`Recipient +${cleanDigits} is not registered on WhatsApp: ${invalidPopupText}`);
        }

        // Wait for chat interface to mount
        await this.page.waitForSelector('#main footer, footer', { timeout: 20000 });

        // Locate file inputs
        let fileInputs = await this.page.$$('input[type="file"]');
        if (fileInputs.length === 0) {
          const attachBtn = await this.page.$(
            'footer button[aria-label="Attach"], button[title="Attach"], span[data-icon="attach-menu-plus"], span[data-icon="plus"]'
          );
          if (attachBtn) {
            await attachBtn.click();
            await new Promise((r) => setTimeout(r, 600));
          }
          fileInputs = await this.page.$$('input[type="file"]');
        }

        if (fileInputs.length === 0) {
          throw new Error('Could not find file input element in WhatsApp Web conversation.');
        }

        // Match input by accept attribute (image vs document)
        let targetInput: any = null;
        for (const input of fileInputs) {
          const accept = await this.page.evaluate((el: HTMLInputElement) => el.getAttribute('accept') || '', input);
          if (isImage && accept.toLowerCase().includes('image')) {
            targetInput = input;
            break;
          } else if (!isImage && (accept === '*' || !accept.toLowerCase().includes('image'))) {
            targetInput = input;
            break;
          }
        }

        if (!targetInput) {
          targetInput = isImage ? fileInputs[fileInputs.length - 1] : fileInputs[0];
        }

        await targetInput.uploadFile(tempFilePath);
        console.log(`[OpenWAProvider] File uploaded to browser input (${cleanFn}, isImage=${isImage})`);

        // Wait for send button or media viewer to appear
        const sendSelector = 'div[aria-label*="Send" i], span[data-icon="send"], button[aria-label*="Send" i], span[data-icon="send-inverted"]';
        await this.page.waitForSelector(sendSelector, { timeout: 20000 });

        // Type caption into caption/compose input if provided
        if (caption) {
          const captionInput = await this.page.$(
            'div[data-testid="media-caption-input-container"] div[contenteditable="true"], div[aria-label*="caption" i], div[contenteditable="true"]'
          );
          if (captionInput) {
            await captionInput.focus();
            await this.page.keyboard.type(caption);
            await new Promise((r) => setTimeout(r, 400));
          }
        }

        // Click send button
        const mediaSendBtn = await this.page.$(sendSelector);
        if (mediaSendBtn) {
          await mediaSendBtn.click();
          await new Promise((r) => setTimeout(r, 2500));
        }
      } else {
        // Pure text-only message dispatch
        console.log(`[OpenWAProvider] Dispatching text-only message to ${cleanDigits}...`);

        const isAlreadyOpen = await this.page.evaluate((digits: string) => {
          const main = document.querySelector('#main');
          if (!main) return false;
          try {
            const req = (window as any).require;
            const activeChat = req('WAWebChatNavState')?.getActiveChat?.();
            if (activeChat?.id?.user === digits) return true;
          } catch (e) {}
          const header = main.querySelector('header')?.textContent || '';
          return header.includes(digits);
        }, cleanDigits);

        if (!isAlreadyOpen) {
          let openedViaAction = false;
          try {
            openedViaAction = await this.page.evaluate(async (digits: string) => {
              const req = (window as any).require;
              if (!req) return false;
              const wf = req('WAWebWidFactory');
              const wid = wf.createWid(`${digits}@c.us`);
              const nav = req('WAWebOpenChatWithContactAction');
              if (nav?.openChatWithContact) {
                await nav.openChatWithContact({ targetId: wid });
                return true;
              }
              return false;
            }, cleanDigits);
          } catch (e) {}

          if (!openedViaAction) {
            const sendUrl = `https://web.whatsapp.com/send?phone=${cleanDigits}&text=${encodeURIComponent(text)}`;
            await this.page.goto(sendUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
          }
        }

        // Check for invalid phone popup modal
        const invalidPopupText = await this.page.evaluate(() => {
          const modal = document.querySelector(
            '[data-animate-modal-popup="true"], [data-testid="confirm-popup"], div[role="dialog"]'
          );
          if (modal) {
            const body = (modal.textContent || '').trim();
            if (
              body.includes('phone number shared via url is invalid') ||
              body.includes("isn't on WhatsApp") ||
              body.includes('tidak terdaftar')
            ) {
              const okBtn = modal.querySelector('button, div[role="button"]');
              if (okBtn) (okBtn as HTMLElement).click();
              return body;
            }
          }
          return null;
        });

        if (invalidPopupText) {
          throw new Error(`Recipient +${cleanDigits} is not registered on WhatsApp: ${invalidPopupText}`);
        }

        // If compose box is empty, type the text
        const composeBox = await this.page.$('#main footer div[contenteditable="true"]');
        if (composeBox) {
          await composeBox.focus();
          const currentText = await this.page.evaluate((el: HTMLElement) => el.innerText?.trim() || '', composeBox);
          if (!currentText) {
            await this.page.keyboard.type(text);
            await new Promise((r) => setTimeout(r, 300));
          }
        }

        // Wait for send button and click
        const sendButton = await this.page.waitForSelector('span[data-icon="send"], button[aria-label="Send"], div[aria-label*="Send" i]', {
          timeout: 20000,
        });

        if (sendButton) {
          await sendButton.click();
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      // Extract real WhatsApp message ID from DOM if available and verify delivery status
      const deliveryVerification = await this.page.evaluate(async () => {
        const checkOutgoing = () => {
          const outMsgs = document.querySelectorAll('.message-out, [data-testid="msg-container"]');
          if (outMsgs.length === 0) return null;
          const lastMsg = outMsgs[outMsgs.length - 1];
          const hasError = lastMsg.querySelector('span[data-icon="msg-error"], span[data-icon="alert-phone"]');
          if (hasError) return { status: 'error', reason: 'WhatsApp reported dispatch error icon in message bubble' };
          const hasDblCheck = lastMsg.querySelector('span[data-icon="msg-dblcheck"]');
          if (hasDblCheck) return { status: 'delivered' };
          const hasCheck = lastMsg.querySelector('span[data-icon="msg-check"]');
          if (hasCheck) return { status: 'sent' };
          const hasClock = lastMsg.querySelector('span[data-icon="msg-time"]');
          if (hasClock) return { status: 'pending' };
          return { status: 'dispatched' };
        };

        // Poll up to 10 seconds for completion of send
        for (let i = 0; i < 20; i++) {
          const res = checkOutgoing();
          if (res && res.status !== 'pending') return res;
          await new Promise((r) => setTimeout(r, 500));
        }
        return checkOutgoing() || { status: 'dispatched' };
      });

      if (deliveryVerification && deliveryVerification.status === 'error') {
        throw new Error(`WhatsApp delivery failed: ${deliveryVerification.reason || 'Message failed to send'}`);
      }

      const realMessageId = await this.page.evaluate(() => {
        const rows = document.querySelectorAll('[data-id]');
        if (rows.length > 0) {
          for (let i = rows.length - 1; i >= 0; i--) {
            const id = rows[i].getAttribute('data-id');
            if (id && id.startsWith('true_')) {
              return id;
            }
          }
        }
        return null;
      });

      const messageId = realMessageId || `wa_sent_${Date.now()}`;
      this.lastSeen = timestamp;
      return {
        success: true,
        messageId,
        timestamp,
      };
    } catch (err: any) {
      console.error(`[OpenWAProvider] Outbound send error to ${cleanDigits}:`, err.message);
      this.lastError = err.message;

      // Timeout reconciliation: verify if message was actually sent before declaring total failure
      let reconciledMessageId: string | null = null;
      if (/timeout|waiting failed/i.test(err.message) && this.page) {
        try {
          reconciledMessageId = await this.page.evaluate(() => {
            const rows = document.querySelectorAll('.message-out[data-id], [data-id]');
            for (let i = rows.length - 1; i >= 0; i--) {
              const id = rows[i].getAttribute('data-id');
              if (id && id.startsWith('true_')) return id;
            }
            return null;
          });
        } catch (e) {}
      }

      if (reconciledMessageId) {
        console.log(`[OpenWAProvider] Reconciled dispatched message despite timeout: ${reconciledMessageId}`);
        return {
          success: true,
          messageId: reconciledMessageId,
          timestamp,
        };
      }

      return {
        success: false,
        messageId: '',
        timestamp,
        error: err.message,
      };
    } finally {
      if (tempFilePath) {
        try {
          if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        } catch {}
      }
    }
  }

  public async getStatus(): Promise<WhatsAppConnectionStatus> {
    if (this.status === 'connected' && !this.authenticatedPhone) {
      await this.extractSessionIdentity();
    }

    return {
      status: this.status,
      session: this.config.sessionId || 'sapj-business-whatsapp',
      businessPhone: this.status === 'connected' ? (this.authenticatedPhone || null) : null,
      businessJid: this.status === 'connected' ? (this.authenticatedJid || null) : null,
      identityVerifiedAt: this.identityVerifiedAt || null,
      identitySource: this.identitySource || null,
      lastSeen: this.lastSeen,
      qrCode: this.status === 'unpaired' ? this.qrCode : null,
      error: this.lastError,
    };
  }

  /**
   * Forwards an inbound message to the Supabase Edge Function Ingress endpoint
   */
  public async forwardInboundToErp(payload: WhatsAppInboundMessage): Promise<{ success: boolean; error?: string }> {
    try {
      const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrcnRzcWllbmxocG91b2htZmtpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE5MTQxNzQsImV4cCI6MjA3NzQ5MDE3NH0.Kjo9RU0WAfQSSEm2vTWmuN5BIYk_hvanKDQkm5qdCGY';

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': this.config.webhookSecret,
        'apikey': anonKey,
        'Authorization': `Bearer ${anonKey}`,
      };

      const res = await fetch(this.config.erpIngressUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error('[OpenWAProvider] ERP Ingress forward failed:', data);
        return { success: false, error: data?.error || `HTTP ${res.status}: Failed to forward to ERP Ingress` };
      }

      console.log(`[OpenWAProvider] Inbound message mirrored to ERP Ingress (${payload.messageId})`);
      return { success: true };
    } catch (err: any) {
      console.error('[OpenWAProvider] ERP Ingress network error:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Diagnostic telemetry for live session inspection (engine version, session status, no credentials)
   */
  public async getDiagnostics(): Promise<Record<string, unknown>> {
    let waWebVersion = 'unknown';
    let browserVersion = 'unknown';
    if (this.browser) {
      try {
        browserVersion = await this.browser.version();
      } catch (e) {}
    }
    let pageUrl: string | null = null;
    let pageTitle: string | null = null;
    let hasPaneSide = false;
    let bodySnippet: string | null = null;

    if (this.page) {
      try {
        pageUrl = this.page.url();
        pageTitle = await this.page.title();
        hasPaneSide = await this.page.evaluate(() => {
          return !!(
            document.querySelector('#pane-side') ||
            document.querySelector('[data-testid="chat-list"]') ||
            document.querySelector('div[aria-label="Chat list"]')
          );
        });
        bodySnippet = await this.page.evaluate(() => (document.body?.innerText || '').slice(0, 120).replace(/\s+/g, ' '));
        waWebVersion = await this.page.evaluate(() => {
          const req = (window as any).require;
          return (window as any).Debug?.VERSION || req?.('WAWebVersion')?.VERSION || 'unknown';
        });
      } catch (e) {}
    }

    return {
      status: this.status,
      session: this.config.sessionId || 'sapj-business-whatsapp',
      authenticatedPhone: this.authenticatedPhone || null,
      authenticatedJid: this.authenticatedJid || null,
      identityVerifiedAt: this.identityVerifiedAt || null,
      identitySource: this.identitySource || null,
      whatsappWebVersion: waWebVersion,
      browserEngine: browserVersion,
      pageUrl,
      pageTitle,
      hasPaneSide,
      bodySnippet,
      lastSeen: this.lastSeen,
      lastError: this.lastError || null,
    };
  }
}
