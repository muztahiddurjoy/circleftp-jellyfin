/**
 * Invite management.
 *
 * An invite is the hands-off way to add someone: they pick their own password
 * and the admin never handles it.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { InviteDto, UserRole } from '@cfj/shared';

import { ApiRequestError, api } from '../../api/client';
import { EmptyState, Spinner } from '../../components/common';
import { Modal, SecretBox } from '../../components/Modal';
import { useToasts } from '../../hooks/useToasts';

export function AdminInvites(): JSX.Element {
  const { notify } = useToasts();
  const queryClient = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<InviteDto | null>(null);

  const invites = useQuery({
    queryKey: ['admin', 'invites'],
    queryFn: () => api.get<{ invites: InviteDto[] }>('/admin/invites'),
  });

  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ['admin', 'invites'] }).then(() => undefined);

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/invites/${id}`),
    onSuccess: async () => {
      notify('Invite revoked', 'success');
      await refresh();
    },
    onError: (error: unknown) =>
      notify(error instanceof ApiRequestError ? error.message : 'Could not revoke', 'error'),
  });

  const rows = invites.data?.invites ?? [];
  const pending = rows.filter((invite) => invite.status === 'pending').length;

  return (
    <section className="section">
      <div className="section__head">
        <div>
          <h2 className="section__title">Invites</h2>
          <p className="section__hint">
            {pending} unused invite{pending === 1 ? '' : 's'} · the invitee chooses their own
            password
          </p>
        </div>
        <button className="button" type="button" onClick={() => setCreating(true)}>
          Create invite
        </button>
      </div>

      {invites.isLoading ? (
        <EmptyState icon="⏳" title="Loading invites…" />
      ) : rows.length === 0 ? (
        <EmptyState icon="✉️" title="No invites yet">
          Create one to let someone set up their own account.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Role</th>
                <th>Status</th>
                <th>Note</th>
                <th>Created</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((invite) => (
                <tr key={invite.id} className={invite.status !== 'pending' ? 'row--disabled' : undefined}>
                  <td>
                    <code style={{ fontSize: 12.5, letterSpacing: '0.04em' }}>{invite.code}</code>
                  </td>
                  <td>
                    <span className={`pill pill--${invite.role}`}>{invite.role}</span>
                  </td>
                  <td>
                    <span className={`pill pill--${invite.status}`}>{invite.status}</span>
                    {invite.usedByName ? (
                      <div className="table__secondary">by {invite.usedByName}</div>
                    ) : invite.status === 'pending' ? (
                      <div className="table__secondary">
                        expires {new Date(invite.expiresAt).toLocaleDateString()}
                      </div>
                    ) : null}
                  </td>
                  <td className="table__secondary">{invite.note ?? '—'}</td>
                  <td className="table__secondary">
                    {new Date(invite.createdAt).toLocaleDateString()}
                    {invite.createdByName ? ` · ${invite.createdByName}` : ''}
                  </td>
                  <td>
                    <div className="table__actions">
                      {invite.status === 'pending' ? (
                        <>
                          <button
                            className="button button--ghost button--small"
                            type="button"
                            onClick={() => setCreated(invite)}
                          >
                            Show link
                          </button>
                          <button
                            className="button button--danger button--small"
                            type="button"
                            disabled={revoke.isPending}
                            onClick={() => revoke.mutate(invite.id)}
                          >
                            Revoke
                          </button>
                        </>
                      ) : (
                        // A redeemed invite is kept as the record of how that
                        // account came to exist, so there is nothing to do.
                        <span className="table__secondary">—</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <CreateInviteModal
          onClose={() => setCreating(false)}
          onCreated={async (invite) => {
            setCreating(false);
            setCreated(invite);
            await refresh();
          }}
        />
      ) : null}

      {created ? (
        <Modal
          title="Invite link"
          subtitle="Send this to whoever is joining. They set their own password."
          onClose={() => setCreated(null)}
        >
          <SecretBox
            value={`${window.location.origin}/invite?code=${encodeURIComponent(created.code)}`}
            label="Invite link"
          />
          <p className="hint">
            The code on its own is <code>{created.code}</code> — it can be typed at /invite if the
            link is awkward to send. Expires{' '}
            {new Date(created.expiresAt).toLocaleString()}.
          </p>
          <div className="modal__actions">
            <button className="button" type="button" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

function CreateInviteModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (invite: InviteDto) => void | Promise<void>;
}): JSX.Element {
  const [role, setRole] = useState<UserRole>('USER');
  const [expiresInDays, setExpiresInDays] = useState(14);
  const [note, setNote] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.post<{ invite: InviteDto }>('/admin/invites', {
        role,
        expiresInDays,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: (result) => void onCreated(result.invite),
  });

  return (
    <Modal title="Create an invite" onClose={onClose}>
      {create.isError ? (
        <div className="auth__error" role="alert">
          {create.error instanceof ApiRequestError
            ? create.error.message
            : 'Could not create the invite'}
        </div>
      ) : null}

      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="form-row">
          <div className="field">
            <label className="field__label" htmlFor="invite-role">
              Role
            </label>
            <select
              id="invite-role"
              className="select"
              value={role}
              onChange={(event) => setRole(event.target.value as UserRole)}
            >
              <option value="USER">User</option>
              <option value="ADMIN">Administrator</option>
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="invite-days">
              Valid for
            </label>
            <select
              id="invite-days"
              className="select"
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(Number(event.target.value))}
            >
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
            </select>
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="invite-note">
            Note (optional)
          </label>
          <input
            id="invite-note"
            className="input"
            maxLength={200}
            placeholder="Who is this for?"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <p className="hint">Only you see this — it is a reminder, not sent to the invitee.</p>
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
