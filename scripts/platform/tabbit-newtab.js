/**
 * Tabbit browser compatibility.
 *
 * Tabbit opens https://web.tabbit.ai/newtab for Ctrl/Cmd+T instead of
 * chrome://newtab/, so chrome_url_overrides alone never kicks in. Redirecting
 * that page to chrome://newtab/ lets the regular override render newtab.html
 * with an empty omnibox. Append ?tabbit-original=1 to reach Tabbit's own page.
 */

const TABBIT_ORIGIN = 'https://web.tabbit.ai';
const TABBIT_NEWTAB_PATH = '/newtab';
const TABBIT_ESCAPE_PARAM = 'tabbit-original';
const NEWTAB_URL = 'chrome://newtab/';

export function isTabbitHome(url) {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        return (
            parsed.origin === TABBIT_ORIGIN &&
            parsed.pathname === TABBIT_NEWTAB_PATH &&
            !parsed.searchParams.has(TABBIT_ESCAPE_PARAM)
        );
    } catch {
        return false;
    }
}

export function registerTabbitNewTab() {
    if (!chrome?.tabs?.onCreated || !chrome.tabs.onUpdated) return;

    const redirecting = new Set();

    async function redirect(tab) {
        const targetUrl = tab?.pendingUrl || tab?.url;
        if (!isTabbitHome(targetUrl) || redirecting.has(tab.id)) return;

        redirecting.add(tab.id);
        try {
            await chrome.tabs.update(tab.id, { url: NEWTAB_URL });
        } catch (error) {
            console.error('[Tabbit-NewTab] Redirect failed:', error);
        } finally {
            redirecting.delete(tab.id);
        }
    }

    chrome.tabs.onCreated.addListener(redirect);
    chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
        if (changeInfo.url) redirect(tab);
    });
}
