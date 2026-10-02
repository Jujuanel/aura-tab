import { describe, it, expect, beforeEach } from 'vitest';
import {
    relativeLuminance,
    parseColorLuminance,
    parseBackgroundPosition,
    mapViewportRectToImage,
    meanLuminance,
    applyWallpaperFilters,
    pickInk,
    applyInkAttributes,
    UI_INK_ZONES
} from '../scripts/domains/backgrounds/ui-ink.js';

describe('ui-ink luminance helpers', () => {
    it('computes WCAG relative luminance', () => {
        expect(relativeLuminance(0, 0, 0)).toBe(0);
        expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 5);
        expect(parseColorLuminance('#fff')).toBeCloseTo(1, 5);
        expect(parseColorLuminance('rgb(0, 0, 0)')).toBe(0);
        expect(parseColorLuminance('not-a-color')).toBeNull();
    });

    it('picks dark ink on white/pastel wallpaper and light ink on dark or saturated ones', () => {
        expect(pickInk(parseColorLuminance('#ffffff'))).toBe('dark');
        expect(pickInk(parseColorLuminance('#f5c6d8'))).toBe('dark');   // cherry-blossom pink
        expect(pickInk(parseColorLuminance('#e6823c'))).toBe('light');  // sunset orange
        expect(pickInk(parseColorLuminance('#1a1a2e'))).toBe('light');
    });

    it('accounts for brightness and overlay filters', () => {
        const white = 1;
        expect(pickInk(applyWallpaperFilters(white))).toBe('dark');
        expect(pickInk(applyWallpaperFilters(white, { brightness: 0.6 }))).toBe('light');
        expect(pickInk(applyWallpaperFilters(white, { overlay: 0.7 }))).toBe('light');
        // Overlay is 20% weaker at the top/bottom edges than in the middle.
        expect(applyWallpaperFilters(white, { overlay: 0.5, yFraction: 0 }))
            .toBeGreaterThan(applyWallpaperFilters(white, { overlay: 0.5, yFraction: 0.5 }));
    });
});

describe('ui-ink geometry', () => {
    it('parses background-position keywords and percentages', () => {
        expect(parseBackgroundPosition('50.00% 30.00%')).toEqual({ x: 0.5, y: 0.3 });
        expect(parseBackgroundPosition('center')).toEqual({ x: 0.5, y: 0.5 });
        expect(parseBackgroundPosition('top')).toEqual({ x: 0.5, y: 0 });
        expect(parseBackgroundPosition('right bottom')).toEqual({ x: 1, y: 1 });
    });

    it('maps viewport rects through background-size: cover', () => {
        // 200x100 image on a 100x100 viewport: cover scales to 100 tall, crops 50px each side.
        const opts = { imageWidth: 200, imageHeight: 100, viewWidth: 100, viewHeight: 100 };
        expect(mapViewportRectToImage({ left: 0, top: 0, right: 100, bottom: 100 }, opts))
            .toEqual({ left: 50, top: 0, right: 150, bottom: 100 });
        expect(mapViewportRectToImage({ left: 0, top: 0, right: 100, bottom: 100 }, { ...opts, position: '0% 50%' }))
            .toEqual({ left: 0, top: 0, right: 100, bottom: 100 });
        expect(mapViewportRectToImage({ left: 0, top: 0, right: 0, bottom: 10 }, opts)).toBeNull();
    });

    it('averages only the pixels inside the region', () => {
        // Left half black, right half white.
        const luma = new Float32Array([0, 0, 1, 1, 0, 0, 1, 1]);
        expect(meanLuminance(luma, 4, 2, { left: 0, top: 0, right: 2, bottom: 2 })).toBe(0);
        expect(meanLuminance(luma, 4, 2, { left: 2, top: 0, right: 4, bottom: 2 })).toBe(1);
        expect(meanLuminance(luma, 4, 2, { left: 0, top: 0, right: 4, bottom: 2 })).toBe(0.5);
    });
});

describe('ui-ink attributes', () => {
    beforeEach(() => {
        for (const zone of Object.keys(UI_INK_ZONES)) {
            document.documentElement.removeAttribute(`data-ink-${zone}`);
        }
    });

    it('writes valid ink values onto <html> and ignores junk', () => {
        applyInkAttributes({ clock: 'dark', dock: 'light', search: 'purple', bogus: 'dark' });
        const root = document.documentElement;
        expect(root.getAttribute('data-ink-clock')).toBe('dark');
        expect(root.getAttribute('data-ink-dock')).toBe('light');
        expect(root.hasAttribute('data-ink-search')).toBe(false);
        expect(root.hasAttribute('data-ink-bogus')).toBe(false);
    });
});
