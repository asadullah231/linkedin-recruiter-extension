/** POPUP — "Saved" tab: search bar + profile cards + empty state. */
import { useMemo, useState } from 'react';
import { ProfileCard } from './ProfileCard';
import type { ScrapedProfile } from '@/types/extraction';

interface Props {
  active: boolean;
  profiles: ScrapedProfile[];
  onDelete: (profileUrl: string) => void;
}

export function ProfilesTab({ active, profiles, onDelete }: Props) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return profiles;
    return profiles.filter((p) => {
      const haystack = [
        p.fullName, p.headline, p.location, p.currentCompany,
        ...(p.hiringPosts || []).map((j) => `${j.title} ${j.location} ${j.companyName}`),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [profiles, query]);

  return (
    <div className={`tab-pane ${active ? 'active' : ''}`} id="tab-profiles">
      <div className="search-bar">
        <input
          type="text"
          id="search-input"
          placeholder="🔍 Search by name, company, location, job..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <main id="profile-list">
        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📭</div>
            <h2>No profiles yet</h2>
            <p>
              Visit any LinkedIn profile
              <br />
              and click <strong>📥 Save Profile</strong>.
              <br />
              <br />
              Or use the <strong>🔗 n8n</strong> tab to pull URLs from a queue and bulk-scrape.
            </p>
          </div>
        ) : (
          filtered.map((p) => <ProfileCard key={p.profileUrl} profile={p} onDelete={onDelete} />)
        )}
      </main>
    </div>
  );
}
