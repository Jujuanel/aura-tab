/**
 * Adaptive ink for the UI that floats directly on the wallpaper
 * (corner buttons, clock, search box, dock + its tooltips).
 *
 * Those elements are white by default, which disappears on light wallpapers.
 * After each wallpaper is applied we sample how bright the wallpaper is behind
 * every zone (accounting for the user's brightness/overlay filters) and set
 * `data-ink-<zone>="dark"|"light"` on <html>. CSS then swaps the zone's tokens
 * to dark text on frosted-white glass. Users can force one ink in settings.
 */

import { getSyncSettings } from '../../platform/settings-contract.js';

export const UI_INK_MODES = Object.freeze(['auto', 'light', 'dark']);
export const UI_INK_STORAGE_KEY = 'aura:uiInk';
/** Mean relative luminance above which white UI stops being legible. */
export const DARK_INK_THRESHOLD = 0.4;

const SAMPLE_MAX_EDGE = 128;
const ZONE_PADDING = 8;
/** Extra vertical reach for the dock so its hover tooltips are covered too. */
const DOCK_TOOLTIP_REACH = 40;

/** zone key -> element id that best represents what sits on the wallpaper. */
export const UI_INK_ZONES = Object.freeze({
    tl: 'refreshBgBtn',
    tr: 'photoInfo',
    bl: 'settingsBtn',
    br: 'searchToggleBtn',
    clock: 'clock',
    date: 'date',
    search: 'searchContainer',
    dock: 'quicklinksContainer'
});

function srgbToLinear(channel) {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(r, g, b) {
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function parseColorLuminance(color) {
    if (typeof color !== 'string') return null;
    const value = color.trim();
    let match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value);
    if (match) {
        let hex = match[1];
        if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
        const n = parseInt(hex, 16);
        return relativeLuminance((n >> 16) & 255, (n >> 8) & 255, n & 255);
    }
    match = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(value);
    if (match) {
        return relativeLuminance(Number(match[1]), Number(match[2]), Number(match[3]));
    }
    return null;
}

function parsePositionComponent(token) {
    if (!token) return 0.5;
    if (token === 'left' || token === 'top') return 0;
    if (token === 'right' || token === 'bottom') return 1;
    if (token === 'center') return 0.5;
    const percent = /^(-?[\d.]+)%$/.exec(token);
    if (percent) return Math.min(Math.max(Number(percent[1]) / 100, 0), 1);
    return 0.5;
}

export function parseBackgroundPosition(position) {
    const tokens = typeof position === 'string' ? position.trim().split(/\s+/) : [];
    let [first, second] = tokens;
    // "top"/"bottom" alone or first describe the vertical axis.
    if ((first === 'top' || first === 'bottom') && second !== 'top' && second !== 'bottom') {
        [first, second] = [second, first];
    }
    return { x: parsePositionComponent(first), y: parsePositionComponent(second) };
}

/**
 * Map a viewport rect onto the sampled image's pixel grid, replicating
 * `background-size: cover|contain` + `background-position` + the layer's scale.
 */
export function mapViewportRectToImage(rect, {
    imageWidth, imageHeight, viewWidth, viewHeight,
    size = 'cover', position = '50% 50%', layerScale = 1
}) {
    if (!(imageWidth > 0 && imageHeight > 0 && viewWidth > 0 && viewHeight > 0)) return null;

    const boxW = viewWidth * layerScale;
    const boxH = viewHeight * layerScale;
    const boxX = (viewWidth - boxW) / 2;
    const boxY = (viewHeight - boxH) / 2;

    const fit = size === 'contain' ? Math.min : Math.max;
    const k = fit(boxW / imageWidth, boxH / imageHeight);
    const drawW = imageWidth * k;
    const drawH = imageHeight * k;
    const pos = parseBackgroundPosition(position);
    const originX = boxX + (boxW - drawW) * pos.x;
    const originY = boxY + (boxH - drawH) * pos.y;

    const clampX = (v) => Math.min(Math.max(v, 0), imageWidth);
    const clampY = (v) => Math.min(Math.max(v, 0), imageHeight);
    const left = clampX((rect.left - originX) / k);
    const right = clampX((rect.right - originX) / k);
    const top = clampY((rect.top - originY) / k);
    const bottom = clampY((rect.bottom - originY) / k);
    if (right - left < 0.5 || bottom - top < 0.5) return null;
    return { left, top, right, bottom };
}

/** Mean of a per-pixel luminance grid inside an image-space rect. */
export function meanLuminance(luma, width, height, rect) {
    const x0 = Math.max(0, Math.floor(rect.left));
    const y0 = Math.max(0, Math.floor(rect.top));
    const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil(rect.right)));
    const y1 = Math.min(height, Math.max(y0 + 1, Math.ceil(rect.bottom)));
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++) {
            sum += luma[row + x];
            count++;
        }
    }
    return count ? sum / count : null;
}

/**
 * Apply the wallpaper filters: `brightness()` scales sRGB values (≈ power 2.2
 * in linear light), then the black overlay gradient (0.8·a at the edges, a in
 * the middle) darkens it further.
 */
export function applyWallpaperFilters(luminance, { brightness = 1, overlay = 0, yFraction = 0.5 } = {}) {
    const lit = Math.min(1, luminance * Math.pow(Math.max(brightness, 0), 2.2));
    const centerWeight = 1 - Math.abs(2 * Math.min(Math.max(yFraction, 0), 1) - 1);
    const alpha = Math.min(Math.max(overlay, 0), 1) * (0.8 + 0.2 * centerWeight);
    return lit * (1 - alpha);
}

export function pickInk(luminance) {
    return luminance > DARK_INK_THRESHOLD ? 'dark' : 'light';
}

function readCssNumber(name, fallback) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
    const value = parseFloat(raw);
    return Number.isFinite(value) ? value : fallback;
}

function extractCssUrl(image) {
    if (typeof image !== 'string') return null;
    const match = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(image);
    return match ? match[2] : null;
}

function loadSample(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => {
            try {
                const iw = img.naturalWidth;
                const ih = img.naturalHeight;
                if (!iw || !ih) return resolve(null);
                const scale = Math.min(1, SAMPLE_MAX_EDGE / Math.max(iw, ih));
                const width = Math.max(1, Math.round(iw * scale));
                const height = Math.max(1, Math.round(ih * scale));
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) return resolve(null);
                ctx.drawImage(img, 0, 0, width, height);
                const data = ctx.getImageData(0, 0, width, height).data;
                const luma = new Float32Array(width * height);
                for (let i = 0, p = 0; p < luma.length; i += 4, p++) {
                    luma[p] = relativeLuminance(data[i], data[i + 1], data[i + 2]);
                }
                resolve({ luma, width, height });
            } catch {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

export function readStoredInk() {
    try {
        const parsed = JSON.parse(localStorage.getItem(UI_INK_STORAGE_KEY) || 'null');
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function writeStoredInk(inks) {
    try {
        localStorage.setItem(UI_INK_STORAGE_KEY, JSON.stringify(inks));
    } catch { }
}

export function applyInkAttributes(inks, root = document.documentElement) {
    for (const zone of Object.keys(UI_INK_ZONES)) {
        const ink = inks?.[zone];
        if (ink === 'dark' || ink === 'light') {
            root.setAttribute(`data-ink-${zone}`, ink);
        }
    }
}

class UiInkController {
    constructor() {
        this.mode = 'auto';
        this.sample = null;      // { luma, width, height, size, position }
        this.solidLuminance = null;
        this.inks = readStoredInk() || {};
        this._loadToken = 0;
        this._frame = 0;
        this._cleanups = [];
    }

    async init() {
        const listen = (target, type, handler, options) => {
            target.addEventListener(type, handler, options);
            this._cleanups.push(() => target.removeEventListener(type, handler, options));
        };

        listen(window, 'background:applied', (event) => { void this._onBackgroundApplied(event.detail); });
        listen(window, 'resize', () => this.schedule());

        const onStorage = (changes, areaName) => {
            if (areaName === 'sync' && changes.uiInkMode) {
                this._setMode(changes.uiInkMode.newValue);
            }
        };
        chrome.storage.onChanged.addListener(onStorage);
        this._cleanups.push(() => chrome.storage.onChanged.removeListener(onStorage));

        if (typeof MutationObserver === 'function') {
            // Filter sliders write --bg-brightness / --bg-overlay inline on <html>.
            const rootObserver = new MutationObserver(() => this.schedule());
            rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
            const dockObserver = new MutationObserver(() => this.schedule());
            const dock = document.getElementById(UI_INK_ZONES.dock);
            if (dock) dockObserver.observe(dock, { attributes: true, attributeFilter: ['data-position', 'data-style', 'class'] });
            this._cleanups.push(() => { rootObserver.disconnect(); dockObserver.disconnect(); });
        }
        if (typeof ResizeObserver === 'function') {
            const resizeObserver = new ResizeObserver(() => this.schedule());
            for (const id of Object.values(UI_INK_ZONES)) {
                const el = document.getElementById(id);
                if (el) resizeObserver.observe(el);
            }
            this._cleanups.push(() => resizeObserver.disconnect());
        }

        try {
            const { uiInkMode } = await getSyncSettings({ uiInkMode: undefined });
            this._setMode(uiInkMode);
        } catch {
            this._setMode('auto');
        }
    }

    destroy() {
        this._cleanups.splice(0).forEach((fn) => { try { fn(); } catch { } });
        if (this._frame) cancelAnimationFrame(this._frame);
        this._frame = 0;
    }

    _setMode(mode) {
        this.mode = UI_INK_MODES.includes(mode) ? mode : 'auto';
        document.documentElement.dataset.inkMode = this.mode;
        this.schedule();
    }

    async _onBackgroundApplied(rawDetail) {
        const detail = rawDetail || {};
        const token = ++this._loadToken;
        this.solidLuminance = parseColorLuminance(detail.color);
        const url = detail.type === 'color' ? null : extractCssUrl(detail.image);
        if (!url) {
            this.sample = null;
            this.schedule();
            return;
        }
        const sample = await loadSample(url);
        if (token !== this._loadToken) return;
        this.sample = sample ? { ...sample, size: detail.size || 'cover', position: detail.position || '50% 50%' } : null;
        this.schedule();
    }

    schedule() {
        if (this._frame) return;
        const run = () => {
            this._frame = 0;
            this.evaluate();
        };
        this._frame = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(run)
            : setTimeout(run, 0);
    }

    evaluate() {
        if (this.mode !== 'auto') {
            const forced = {};
            for (const zone of Object.keys(UI_INK_ZONES)) forced[zone] = this.mode;
            applyInkAttributes(forced);
            // Persist for first paint, but keep this.inks as the last auto result.
            writeStoredInk(forced);
            return;
        }
        if (!this.sample && this.solidLuminance == null) return;

        const viewWidth = window.innerWidth;
        const viewHeight = window.innerHeight;
        const filters = {
            brightness: readCssNumber('--bg-brightness', 1),
            overlay: readCssNumber('--bg-overlay', 0)
        };
        const layerScale = this.sample ? readCssNumber('--scale-lift', 1) : 1;
        const next = { ...this.inks };

        for (const [zone, id] of Object.entries(UI_INK_ZONES)) {
            const el = document.getElementById(id);
            const box = el?.getBoundingClientRect();
            if (!box || box.width <= 0 || box.height <= 0) continue;
            const reach = zone === 'dock' ? DOCK_TOOLTIP_REACH : ZONE_PADDING;
            const rect = {
                left: box.left - ZONE_PADDING,
                right: box.right + ZONE_PADDING,
                top: box.top - reach,
                bottom: box.bottom + reach
            };

            let luminance = this.solidLuminance;
            if (this.sample) {
                const imageRect = mapViewportRectToImage(rect, {
                    imageWidth: this.sample.width,
                    imageHeight: this.sample.height,
                    viewWidth,
                    viewHeight,
                    size: this.sample.size,
                    position: this.sample.position,
                    layerScale
                });
                if (imageRect) {
                    luminance = meanLuminance(this.sample.luma, this.sample.width, this.sample.height, imageRect);
                }
            }
            if (luminance == null) continue;

            const yFraction = viewHeight > 0 ? ((box.top + box.bottom) / 2) / viewHeight : 0.5;
            next[zone] = pickInk(applyWallpaperFilters(luminance, { ...filters, yFraction }));
        }

        this.inks = next;
        applyInkAttributes(next);
        writeStoredInk(next);
    }
}

export const uiInk = new UiInkController();

export function initUiInk() {
    return uiInk.init();
}
