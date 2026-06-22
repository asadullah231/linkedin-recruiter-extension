/**
 * BACKGROUND — STORAGE OPERATIONS
 * ────────────────────────────────
 * Profiles are keyed by profileUrl in chrome.storage.local under "profiles".
 * Also keeps the toolbar badge count in sync.
 */

async function saveProfile(profileData) {
    if (!profileData || !profileData.profileUrl) {
        throw new Error('Invalid profile data — missing profileUrl');
    }

    const stored = await chrome.storage.local.get('profiles');
    const profiles = stored.profiles || {};
    profiles[profileData.profileUrl] = profileData;
    await chrome.storage.local.set({ profiles });

    const count = Object.keys(profiles).length;
    chrome.action.setBadgeText({ text: count > 99 ? '99+' : String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#0a66c2' });

    return {
        savedAt: new Date().toISOString(),
        totalProfiles: count,
        profile: profileData.fullName
    };
}

async function getAllProfiles() {
    const stored = await chrome.storage.local.get('profiles');
    const profiles = stored.profiles || {};
    return Object.values(profiles).sort((a, b) =>
        new Date(b.scrapedAt) - new Date(a.scrapedAt)
    );
}

async function deleteProfile(profileUrl) {
    const stored = await chrome.storage.local.get('profiles');
    const profiles = stored.profiles || {};
    delete profiles[profileUrl];
    await chrome.storage.local.set({ profiles });
    const count = Object.keys(profiles).length;
    chrome.action.setBadgeText({ text: count > 0 ? (count > 99 ? '99+' : String(count)) : '' });
}
