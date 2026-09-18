/**
 * User management.
 *
 * Actions that could lock everyone out are disabled in the UI *and* refused by
 * the server — this is the friendly half of that pair, showing why rather than
 * waiting for a 409.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { AdminUserDto, CreatedUserDto, PasswordResetDto, UserRole } from '@cfj/shared';

import { ApiRequestError, api } from '../../api/client';
import { EmptyState, Spinner } from '../../components/common';
import { Modal, SecretBox } from '../../components/Modal';
import { useToasts } from '../../hooks/useToasts';

export function AdminUsers(): JSX.Element {
  const { notify } = useToasts();
  const queryClient = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedUserDto | null>(null);
  const [resetLink, setResetLink] = useState<PasswordResetDto | null>(null);

  const users = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<{ users: AdminUserDto[] }>('/admin/users'),
  });

  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }).then(() => undefined);

  function reportError(error: unknown, fallback: string): void {
    notify(error instanceof ApiRequestError ? error.message : fallback, 'error');
  }

  const update = useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: Record<string, unknown> }) =>
      api.patch<{ user: AdminUserDto }>(`/admin/users/${id}`, changes),
    onSuccess: async (_result, variables) => {
      notify(describeChange(variables.changes), 'success');
      await refresh();
    },
    onError: (error) => reportError(error, 'Could not update that account'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/users/${id}`),
    onSuccess: async () => {
      notify('Account deleted', 'success');
      await refresh();
    },
    onError: (error) => reportError(error, 'Could not delete that account'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.post<{ endedCount: number }>(`/admin/users/${id}/revoke-sessions`),
    onSuccess: async (result) => {
      notify(
        result.endedCount === 0
          ? 'That account had no open sessions'
          : `Signed out ${result.endedCount} session${result.endedCount === 1 ? '' : 's'}`,
        'success',
      );
      await refresh();
    },
    onError: (error) => reportError(error, 'Could not sign that account out'),
  });

  const issueReset = useMutation({
    mutationFn: (id: string) =>
      api.post<PasswordResetDto>(`/admin/users/${id}/reset-link`, { expiresInHours: 24 }),
    onSuccess: (result) => setResetLink(result),
    onError: (error) => reportError(error, 'Could not create a reset link'),
  });

  const rows = users.data?.users ?? [];
  const adminCount = rows.filter((user) => user.role === 'ADMIN' && !user.disabled).length;
  const busy = update.isPending || remove.isPending || revoke.isPending || issueReset.isPending;

  return (
    <section className="section">
      <div className="section__head">
        <div>
          <h2 className="section__title">Users</h2>
          <p className="section__hint">
            {rows.length} account{rows.length === 1 ? '' : 's'} · {adminCount} administrator
            {adminCount === 1 ? '' : 's'}
          </p>
        </div>
        <button className="button" type="button" onClick={() => setCreating(true)}>
          Add user
        </button>
      </div>

      {users.isLoading ? (
        <EmptyState icon="⏳" title="Loading users…" />
      ) : users.isError ? (
        <EmptyState icon="⚠️" title="Could not load users" error>
          {users.error instanceof Error ? users.error.message : 'Unknown error'}
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th>Downloads</th>
                <th>Sessions</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((user) => {
                // The last active admin cannot be demoted, disabled or deleted;
                // the server enforces it, and showing it greyed explains why.
                const isLastAdmin = user.role === 'ADMIN' && !user.disabled && adminCount <= 1;

                return (
                  <tr key={user.id} className={user.disabled ? 'row--disabled' : undefined}>
                    <td>
                      <div className="table__primary">
                        {user.name}
                        {user.isSelf ? ' (you)' : ''}
                      </div>
                      <div className="table__secondary">{user.email}</div>
                    </td>
                    <td>
                      <span className={`pill pill--${user.role}`}>{user.role}</span>
                    </td>
                    <td>
                      <span className={`pill pill--${user.disabled ? 'off' : 'on'}`}>
                        {user.disabled ? 'disabled' : 'active'}
                      </span>
                    </td>
                    <td className="table__num">{user.downloadCount}</td>
                    <td className="table__num" title={user.lastSeenAt ?? 'Never signed in'}>
                      {user.sessionCount}
                    </td>
                    <td>
                      <div className="table__actions">
                        <button
                          className="button button--ghost button--small"
                          type="button"
                          disabled={busy || isLastAdmin}
                          title={
                            isLastAdmin
                              ? 'The only administrator cannot be demoted'
                              : user.role === 'ADMIN'
                                ? 'Make this a regular user'
                                : 'Make this an administrator'
                          }
                          onClick={() =>
                            update.mutate({
                              id: user.id,
                              changes: { role: user.role === 'ADMIN' ? 'USER' : 'ADMIN' },
                            })
                          }
                        >
                          {user.role === 'ADMIN' ? 'Demote' : 'Promote'}
                        </button>

                        <button
                          className="button button--ghost button--small"
                          type="button"
                          disabled={busy}
                          onClick={() => issueReset.mutate(user.id)}
                        >
                          Reset password
                        </button>

                        <button
                          className="button button--ghost button--small"
                          type="button"
                          disabled={busy || user.sessionCount === 0}
                          onClick={() => revoke.mutate(user.id)}
                        >
                          Sign out
                        </button>

                        <button
                          className="button button--ghost button--small"
                          type="button"
                          disabled={busy || user.isSelf || isLastAdmin}
                          title={
                            user.isSelf
                              ? 'You cannot disable your own account'
                              : isLastAdmin
                                ? 'The only administrator cannot be disabled'
                                : undefined
                          }
                          onClick={() =>
                            update.mutate({ id: user.id, changes: { disabled: !user.disabled } })
                          }
                        >
                          {user.disabled ? 'Enable' : 'Disable'}
                        </button>

                        <button
                          className="button button--danger button--small"
                          type="button"
                          disabled={busy || user.isSelf || isLastAdmin}
                          title={
                            user.isSelf
                              ? 'You cannot delete your own account'
                              : isLastAdmin
                                ? 'The only administrator cannot be deleted'
                                : undefined
                          }
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete ${user.name} (${user.email})?\n\n` +
                                  'Their download history is kept, but the account is gone for good.',
                              )
                            ) {
                              remove.mutate(user.id);
                            }
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <CreateUserModal
          onClose={() => setCreating(false)}
          onCreated={async (result) => {
            setCreating(false);
            // Only worth a modal when there is a generated password to show.
            if (result.generatedPassword) setCreated(result);
            else notify(`Created ${result.user.email}`, 'success');
            await refresh();
          }}
        />
      ) : null}

      {created?.generatedPassword ? (
        <Modal
          title="Account created"
          subtitle={`Give ${created.user.name} these details to sign in.`}
          onClose={() => setCreated(null)}
        >
          <div className="field">
            <span className="field__label">Email</span>
            <div className="secret">
              <code className="secret__value">{created.user.email}</code>
            </div>
          </div>
          <div className="field">
            <span className="field__label">Password</span>
            <SecretBox value={created.generatedPassword} label="Generated password" />
          </div>
          <div className="modal__actions">
            <button className="button" type="button" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </Modal>
      ) : null}

      {resetLink ? (
        <Modal
          title="Password reset link"
          subtitle={
            <>
              Send this to {resetLink.userName} ({resetLink.userEmail}). It works once and expires{' '}
              {new Date(resetLink.expiresAt).toLocaleString()}.
            </>
          }
          onClose={() => setResetLink(null)}
        >
          {/* Absolute, because the admin is going to paste this elsewhere. */}
          <SecretBox value={`${window.location.origin}${resetLink.url}`} label="Reset link" />
          <p className="hint">
            You will not see their new password — they choose it themselves. Any earlier reset link
            for this account has stopped working.
          </p>
          <div className="modal__actions">
            <button className="button" type="button" onClick={() => setResetLink(null)}>
              Done
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

function describeChange(changes: Record<string, unknown>): string {
  if (changes.role) return `Role changed to ${String(changes.role).toLowerCase()}`;
  if (changes.disabled === true) return 'Account disabled and signed out';
  if (changes.disabled === false) return 'Account enabled';
  return 'Account updated';
}

function CreateUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (result: CreatedUserDto) => void | Promise<void>;
}): JSX.Element {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('USER');
  const [error, setError] = useState<ApiRequestError | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<CreatedUserDto>('/admin/users', { name: name.trim(), email: email.trim(), role }),
    onSuccess: (result) => void onCreated(result),
    onError: (caught: unknown) =>
      setError(caught instanceof ApiRequestError ? caught : null),
  });

  return (
    <Modal
      title="Add a user"
      subtitle="A strong password is generated and shown once."
      onClose={onClose}
    >
      {error && !error.details ? (
        <div className="auth__error" role="alert">
          {error.message}
        </div>
      ) : null}

      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (name.trim() && email.trim()) create.mutate();
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="new-user-name">
            Name
          </label>
          <input
            id="new-user-name"
            className={error?.fieldError('name') ? 'input input--error' : 'input'}
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {error?.fieldError('name') ? (
            <div className="field__error">{error.fieldError('name')}</div>
          ) : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="new-user-email">
            Email
          </label>
          <input
            id="new-user-email"
            className={error?.fieldError('email') ? 'input input--error' : 'input'}
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          {error?.fieldError('email') ? (
            <div className="field__error">{error.fieldError('email')}</div>
          ) : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="new-user-role">
            Role
          </label>
          <select
            id="new-user-role"
            className="select"
            value={role}
            onChange={(event) => setRole(event.target.value as UserRole)}
          >
            <option value="USER">User — can search and queue downloads</option>
            <option value="ADMIN">Administrator — can also manage users</option>
          </select>
        </div>

        <div className="modal__actions">
          <button className="button button--ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button" type="submit" disabled={create.isPending}>
            {create.isPending ? <Spinner /> : null}
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}
