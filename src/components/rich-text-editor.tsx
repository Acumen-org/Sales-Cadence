'use client';

import { useEffect, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

export function RichTextEditor({ value, onChange, label, disabled = false }: {
  value: string; onChange: (html: string, text: string) => void; label: string; disabled?: boolean;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    extensions: [StarterKit.configure({ code: false, codeBlock: false, heading: false, horizontalRule: false, link: { openOnClick: false, protocols: ['mailto'] } })],
    content: value,
    editable: !disabled,
    editorProps: { attributes: { role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', class: 'max-h-[44vh] min-h-40 overflow-y-auto scroll-thin px-4 py-3 text-[14px] leading-7 text-ink-900 outline-none [&_a]:font-medium [&_a]:text-brand-700 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:mb-2' } },
    onUpdate: ({ editor: e }) => onChange(e.getHTML(), e.getText()),
  });
  useEffect(() => { editor?.setEditable(!disabled); }, [editor, disabled]);
  useEffect(() => {
    if (editor && editor.getHTML() !== value && !editor.isFocused) editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);
  if (!editor) return <div className="min-h-48 animate-pulse rounded-xl bg-canvas" aria-label="Loading editor" />;
  const controls = [
    { label: 'Bold', text: <strong>B</strong>, active: editor.isActive('bold'), run: () => editor.chain().focus().toggleBold().run() },
    { label: 'Italic', text: <em>I</em>, active: editor.isActive('italic'), run: () => editor.chain().focus().toggleItalic().run() },
    { label: 'Underline', text: <u>U</u>, active: editor.isActive('underline'), run: () => editor.chain().focus().toggleUnderline().run() },
    { label: 'Bulleted list', text: '• List', active: editor.isActive('bulletList'), run: () => editor.chain().focus().toggleBulletList().run() },
    { label: 'Numbered list', text: '1. List', active: editor.isActive('orderedList'), run: () => editor.chain().focus().toggleOrderedList().run() },
  ];
  return <div className="overflow-hidden rounded-xl border border-line bg-white">
    {!disabled && <div role="toolbar" aria-label={`${label} formatting`} className="flex flex-wrap items-center gap-1 border-b border-line bg-canvas/60 px-2 py-1.5">
      {controls.map(c => <button type="button" key={c.label} title={c.label} aria-label={c.label} aria-pressed={c.active} onMouseDown={e => e.preventDefault()} onClick={c.run} className={`rounded px-2.5 py-1 text-sm ${c.active ? 'bg-brand-100 text-brand-900' : 'text-ink-700 hover:bg-white'}`}>{c.text}</button>)}
      <button type="button" className="btn-ghost btn-sm" onClick={() => { setUrl(editor.getAttributes('link').href ?? ''); setLinkOpen(!linkOpen); }}>Link</button>
      {editor.isActive('link') && <button type="button" className="btn-ghost btn-sm" onClick={() => editor.chain().focus().unsetLink().run()}>Unlink</button>}
      <button type="button" className="btn-ghost btn-sm ml-auto" aria-label="Undo" onClick={() => editor.chain().focus().undo().run()}>↶</button>
      <button type="button" className="btn-ghost btn-sm" aria-label="Redo" onClick={() => editor.chain().focus().redo().run()}>↷</button>
    </div>}
    {linkOpen && <div className="flex flex-wrap gap-2 border-b border-line p-2">
      <input aria-label="Link URL" className="min-w-0 flex-1" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://" />
      <button type="button" className="btn-secondary btn-sm" onClick={() => {
        if (!/^(https?:\/\/|mailto:)/i.test(url.trim())) { setError('Use an https, http or mailto link.'); return; }
        editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run(); setLinkOpen(false); setError('');
      }}>Apply link</button>
      <button type="button" className="btn-ghost btn-sm" onClick={() => setLinkOpen(false)}>Cancel</button>
      {error && <p role="alert" className="w-full text-sm text-red-700">{error}</p>}
    </div>}
    <EditorContent editor={editor} />
  </div>;
}
