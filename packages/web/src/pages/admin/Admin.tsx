import { useSearchParams } from 'react-router-dom';

import { AdminInvites } from './Invites';
import { AdminUsers } from './Users';

type Tab = 'users' | 'invites';

const TABS: { value: Tab; label: string }[] = [
  { value: 'users', label: 'Users' },
  { value: 'invites', label: 'Invites' },
];

export function AdminPage(): JSX.Element {
  // The tab lives in the URL so a reload keeps you where you were.
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'invites' ? 'invites' : 'users';

  return (
    <div className="page">
      <h1 className="page__title">Administration</h1>
      <p className="page__subtitle">Manage who can sign in and what they can do.</p>

      <div className="tabs" role="tablist">
        {TABS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={tab === option.value}
            className={tab === option.value ? 'tabs__item tabs__item--active' : 'tabs__item'}
            onClick={() => setParams(option.value === 'users' ? {} : { tab: option.value })}
          >
            {option.label}
          </button>
        ))}
      </div>

      {tab === 'users' ? <AdminUsers /> : <AdminInvites />}
    </div>
  );
}
