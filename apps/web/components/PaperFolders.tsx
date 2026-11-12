'use client';

import { useState } from 'react';
import {
  paperShelves,
  shelvesForPaper,
  type PaperFolder,
  type PaperShelf,
  type usePaperFolders,
} from '../lib/paper-folders';
import type { UserPaper } from '../lib/types';
import { Field, Icon, Modal, Notice } from './ui';
import styles from './PaperFolders.module.css';

type FolderStore = ReturnType<typeof usePaperFolders>;
export type FolderEditorTarget =
  { action: 'create'; shelf: PaperShelf } | { action: 'rename' | 'remove'; folder: PaperFolder };

export function FolderGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function PaperFolderBar({
  shelf,
  folders,
  current,
  onSelect,
  onEdit,
}: {
  shelf: PaperShelf;
  folders: PaperFolder[];
  current: PaperFolder | null;
  onSelect: (id: string | null) => void;
  onEdit: (target: FolderEditorTarget) => void;
}) {
  const title = paperShelves[shelf];
  return (
    <section className={styles.bar} aria-label={`${title} folders`}>
      <div className={styles.heading}>
        <h2>
          <FolderGlyph /> {title} folders
        </h2>
        <button className="button small" type="button" onClick={() => onEdit({ action: 'create', shelf })}>
          <Icon name="plus" size={14} /> New folder
        </button>
      </div>
      {folders.length > 0 && (
        <div className={styles.choices} role="group" aria-label={`Browse ${title.toLowerCase()} folders`}>
          <button
            className={styles.choice}
            type="button"
            aria-pressed={!current}
            onClick={() => onSelect(null)}
          >
            All {title.toLowerCase()}
          </button>
          {folders.map((folder) => (
            <button
              key={folder.id}
              className={styles.choice}
              type="button"
              aria-pressed={current?.id === folder.id}
              onClick={() => onSelect(folder.id)}
            >
              {folder.name}
            </button>
          ))}
        </div>
      )}
      {current && (
        <div className={styles.manage}>
          <button
            type="button"
            className="text-link"
            onClick={() => onEdit({ action: 'rename', folder: current })}
          >
            Rename folder
          </button>
          <button
            type="button"
            className="text-link"
            onClick={() => onEdit({ action: 'remove', folder: current })}
          >
            Delete folder
          </button>
        </div>
      )}
    </section>
  );
}

export function PaperFolderEditor({
  target,
  store,
  onClose,
}: {
  target: FolderEditorTarget;
  store: FolderStore;
  onClose: () => void;
}) {
  const [name, setName] = useState(target.action === 'create' ? '' : target.folder.name);
  const [error, setError] = useState('');
  const removing = target.action === 'remove';
  return (
    <Modal
      title={
        target.action === 'create'
          ? `New folder in ${paperShelves[target.shelf]}`
          : removing
            ? 'Delete folder'
            : 'Rename folder'
      }
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          try {
            if (target.action === 'create') store.createFolder(target.shelf, name);
            else if (target.action === 'rename') store.renameFolder(target.folder.id, name);
            else store.removeFolder(target.folder.id);
            onClose();
          } catch (error) {
            setError(error instanceof Error ? error.message : 'Could not change the folder.');
          }
        }}
      >
        {target.action === 'remove' ? (
          <p>
            Papers in “{target.folder.name}” will still appear in {paperShelves[target.folder.shelf]}.
          </p>
        ) : (
          <Field label="Folder name">
            <input
              autoFocus
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="modal-footer">
          <button className="button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`button ${removing ? 'danger' : 'primary'}`}
            disabled={!removing && !name.trim()}
          >
            {target.action === 'create' ? 'Create folder' : removing ? 'Delete folder' : 'Save name'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function OrganizePaperFolders({
  paper,
  store,
  onClose,
}: {
  paper: UserPaper;
  store: FolderStore;
  onClose: () => void;
}) {
  const [newShelf, setNewShelf] = useState<PaperShelf>();
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  function change(operation: () => void) {
    try {
      operation();
      setError('');
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not change the folder.');
      return false;
    }
  }

  return (
    <Modal title="Organize paper" onClose={onClose}>
      <p className={styles.paperTitle}>{paper.paper.title}</p>
      <div className={styles.groups}>
        {shelvesForPaper(paper).map((shelf) => {
          const folders = store.folders.filter((folder) => folder.shelf === shelf);
          return (
            <section key={shelf} className={styles.shelf} aria-label={paperShelves[shelf]}>
              <div className={styles.heading}>
                <h3>
                  <FolderGlyph /> {paperShelves[shelf]}
                </h3>
                {newShelf !== shelf && (
                  <button
                    className="button small"
                    type="button"
                    onClick={() => {
                      setName('');
                      setNewShelf(shelf);
                    }}
                  >
                    <Icon name="plus" size={14} /> New folder
                  </button>
                )}
              </div>
              {folders.map((folder) => (
                <label key={folder.id} className={styles.folderCheck}>
                  <input
                    type="checkbox"
                    checked={folder.paperIds.includes(paper.id)}
                    onChange={() => change(() => store.togglePaper(folder.id, paper.id))}
                  />
                  <span>{folder.name}</span>
                </label>
              ))}
              {newShelf === shelf && (
                <form
                  className={styles.newFolder}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (change(() => store.createFolder(shelf, name, paper.id))) {
                      setNewShelf(undefined);
                      setName('');
                    }
                  }}
                >
                  <Field label="Folder name">
                    <input
                      autoFocus
                      value={name}
                      maxLength={100}
                      required
                      onChange={(event) => setName(event.target.value)}
                    />
                  </Field>
                  <button className="button primary small" disabled={!name.trim()}>
                    Create and add
                  </button>
                </form>
              )}
            </section>
          );
        })}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="modal-footer">
        <button className="button primary" type="button" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
