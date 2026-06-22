/** POPUP — a single saved-profile card (avatar, identity, hiring jobs, actions). */
import { useState } from 'react';
import type { HiringPost } from '@/types/profile';
import type { JobDetails, ScrapedProfile } from '@/types/extraction';

type StoredJob = HiringPost & Partial<JobDetails>;

interface Props {
  profile: ScrapedProfile;
  onDelete: (profileUrl: string) => void;
}

export function ProfileCard({ profile: p, onDelete }: Props) {
  const [copied, setCopied] = useState(false);

  const initials = p.fullName
    ? p.fullName.split(' ').slice(0, 2).map((n) => n[0]).join('').toUpperCase()
    : '??';

  const jobs = (p.hiringPosts || []) as StoredJob[];

  const copyJson = async () => {
    await navigator.clipboard.writeText(JSON.stringify(p, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const del = () => {
    if (confirm('Delete this profile?')) onDelete(p.profileUrl);
  };

  return (
    <div className="profile-card">
      <div className="profile-header">
        {p.profilePic ? (
          <img className="profile-avatar" src={p.profilePic} alt={p.fullName || '?'} />
        ) : (
          <div
            className="profile-avatar"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#6b7280' }}
          >
            {initials}
          </div>
        )}
        <div className="profile-info">
          <div className="profile-name">
            {p.fullName || 'Unknown'}{' '}
            {p.enriched && (
              <span style={{ background: '#dcfce7', color: '#166534', padding: '2px 6px', borderRadius: 10, fontSize: 10, fontWeight: 600 }}>
                ✨ enriched
              </span>
            )}
          </div>
          <div className="profile-headline">{p.headline || 'No headline'}</div>
          <div className="profile-meta">
            {p.location && <span className="meta-item">📍 {p.location}</span>}
            {p.currentCompany && <span className="meta-item">🏢 {p.currentCompany}</span>}
          </div>
        </div>
      </div>

      {p.hasHiringBadge && (
        <div className="hiring-badge">🔥 {p.hiringPostsCount || 0} active hiring posts</div>
      )}

      {jobs.length > 0 && (
        <div className="hiring-jobs-list">
          {jobs.slice(0, 5).map((job, i) => (
            <div className="hiring-job-item" key={job.jobId ?? i}>
              <strong>{job.title || 'Untitled'}</strong>
              {job.location ? ` · ${job.location}` : ''}
              {job.applicantsCount ? ` · ${job.applicantsCount}` : ''}
            </div>
          ))}
          {jobs.length > 5 && (
            <div className="hiring-job-item" style={{ color: '#6b7280', fontStyle: 'italic' }}>
              + {jobs.length - 5} more
            </div>
          )}
        </div>
      )}

      <div className="profile-actions">
        <button className="action-btn" onClick={() => chrome.tabs.create({ url: p.profileUrl })}>
          ↗️ Open
        </button>
        <button className="action-btn" onClick={copyJson}>
          {copied ? '✅' : '📋 JSON'}
        </button>
        <button className="action-btn action-btn-danger" onClick={del}>
          🗑️
        </button>
      </div>
    </div>
  );
}
