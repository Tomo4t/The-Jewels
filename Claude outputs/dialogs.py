import io, json, collections, sys, re

# ------------------------------------------------------------------ i18n ----
COMMON = {'en':'Confirm','fr':'Confirmer','es':'Confirmar','ja':'実行','pl':'Potwierdź'}
EXTRA = {
 'en': {'removeTitle':'Remove {username}?','removeKeep':'Keep their comments',
        'removePurge':'Erase everything','removeHint':'Erasing cannot be undone. Keeping their comments leaves them as "Deleted account".',
        'sendTitle':'Send this newsletter?','sendHint':'It goes to everyone subscribed and cannot be taken back.',
        'muteTitle':'Stop {username} commenting'},
 'fr': {'removeTitle':'Supprimer {username} ?','removeKeep':'Garder ses commentaires',
        'removePurge':'Tout effacer','removeHint':'L’effacement est irréversible. Garder les commentaires les laisse en « Compte supprimé ».',
        'sendTitle':'Envoyer cette infolettre ?','sendHint':'Elle part à tous les abonnés et ne peut pas être rappelée.',
        'muteTitle':'Empêcher {username} de commenter'},
 'es': {'removeTitle':'¿Eliminar a {username}?','removeKeep':'Conservar sus comentarios',
        'removePurge':'Borrarlo todo','removeHint':'Borrar no se puede deshacer. Conservar los comentarios los deja como «Cuenta eliminada».',
        'sendTitle':'¿Enviar este boletín?','sendHint':'Va a todos los suscriptores y no se puede deshacer.',
        'muteTitle':'Impedir que {username} comente'},
 'ja': {'removeTitle':'{username} を削除しますか？','removeKeep':'コメントは残す',
        'removePurge':'すべて消去する','removeHint':'消去は取り消せません。コメントを残すと「削除されたアカウント」として表示されます。',
        'sendTitle':'このニュースレターを送信しますか？','sendHint':'購読者全員に送信され、取り消せません。',
        'muteTitle':'{username} のコメントを停止'},
 'pl': {'removeTitle':'Usunąć {username}?','removeKeep':'Zachowaj komentarze',
        'removePurge':'Wymaż wszystko','removeHint':'Wymazania nie można cofnąć. Zachowane komentarze zostaną jako „Usunięte konto”.',
        'sendTitle':'Wysłać ten newsletter?','sendHint':'Trafi do wszystkich subskrybentów i nie da się tego cofnąć.',
        'muteTitle':'Zablokuj komentowanie dla {username}'},
}
for code, word in COMMON.items():
    p=f'src/i18n/{code}.json'
    d=json.load(io.open(p,encoding='utf-8'), object_pairs_hook=collections.OrderedDict)
    d.setdefault('common', collections.OrderedDict())['confirm']=word
    d['admin'].update(EXTRA[code])
    io.open(p,'w',encoding='utf-8').write(json.dumps(d,indent=2,ensure_ascii=False)+'\n')
print('i18n ok')

# --------------------------------------------------------------- admin/main -
p='src/admin/main.js'; s=io.open(p,encoding='utf-8').read()
s = s.replace("import { toast, toastError, toastSuccess } from '../components/toast.js';",
              "import { toast, toastError, toastSuccess } from '../components/toast.js';\nimport { confirmDialog, chooseDialog } from '../components/modal.js';", 1)

# 1. delete a chapter
s = s.replace("      if (!window.confirm(t('admin.confirmDeleteChapter'))) return;",
"""      const goAhead = await confirmDialog({
        title: t('admin.confirmDeleteChapter'),
        confirmLabel: t('common.delete'),
        danger: true,
      });
      if (!goAhead) return;""", 1)

# 2. mute: a prompt asking for a number becomes real buttons
old_mute = re.search(r"      let span = 'lift';\n      if \(!lifting\) \{\n(?:.*\n)*?      \}\n", s)
if not old_mute: sys.exit('mute prompt block not found')
s = s.replace(old_mute.group(0),
"""      let span = 'lift';
      if (!lifting) {
        span = await chooseDialog({
          title: t('admin.muteTitle', { username }),
          options: [
            { label: t('admin.muteHour'), value: 'hour' },
            { label: t('admin.muteDay'), value: 'day' },
            { label: t('admin.muteWeek'), value: 'week' },
            { label: t('admin.muteForever'), value: 'forever', danger: true },
          ],
        });
        if (!span) return;
      }
""", 1)

# 3. removing an account: two stacked confirms become one clear question
old_remove = """      if (!window.confirm(t('admin.confirmRemove', { username }))) return;
      const mode = window.confirm(t('admin.chooseMode')) ? 'purge' : 'anonymise';"""
new_remove = """      const mode = await chooseDialog({
        title: t('admin.removeTitle', { username }),
        hint: t('admin.removeHint'),
        options: [
          { label: t('admin.removeKeep'), value: 'anonymise' },
          { label: t('admin.removePurge'), value: 'purge', danger: true },
        ],
      });
      if (!mode) return;"""
if old_remove not in s: sys.exit('remove confirms not found')
s = s.replace(old_remove, new_remove, 1)

# 4. disconnecting Drive
s = s.replace("      if (!window.confirm(t('admin.backups.confirmDisconnect'))) return;",
"""      const goAhead = await confirmDialog({
        title: t('admin.backups.confirmDisconnect'),
        confirmLabel: t('admin.backups.disconnect'),
      });
      if (!goAhead) return;""", 1)

# 5. sending the newsletter -- the one that was silently doing nothing
s = s.replace("""      // Irreversible and public. A confirm here is worth the friction.
      if (!window.confirm(t('admin.news.confirmSend', { count: subscribers }))) return;""",
"""      // Irreversible and public, so it is worth asking -- but asked in the
      // page. A native confirm that the browser has suppressed returns false,
      // which turned this button into one that silently did nothing.
      const goAhead = await confirmDialog({
        title: t('admin.news.sendTitle'),
        message: t('admin.news.confirmSend', { count: subscribers }),
        hint: t('admin.news.sendHint'),
        confirmLabel: t('admin.news.sendToAll', { count: subscribers }),
        danger: true,
      });
      if (!goAhead) return;""", 1)
io.open(p,'w',encoding='utf-8').write(s); print('admin dialogs replaced')

# --------------------------------------------------------------- comments ---
p='src/components/comments.js'; s=io.open(p,encoding='utf-8').read()
s = s.replace("import { t", "import { confirmDialog } from './modal.js';\nimport { t", 1)
s = s.replace("          if (!window.confirm(t('comments.confirmDelete'))) return;",
"""          const goAhead = await confirmDialog({
            title: t('comments.confirmDelete'),
            confirmLabel: t('common.delete'),
            danger: true,
          });
          if (!goAhead) return;""", 1)
io.open(p,'w',encoding='utf-8').write(s); print('comments dialog replaced')

# ---------------------------------------------------------------- profile ---
p='src/pages/profile.js'; s=io.open(p,encoding='utf-8').read()
s = s.replace("import { toastSuccess, toastError } from '../components/toast.js';",
              "import { toastSuccess, toastError } from '../components/toast.js';\nimport { confirmDialog } from '../components/modal.js';", 1)
s = s.replace("    if (!window.confirm(`${t('account.deleteWarn')}\\n\\n${warning}`)) return;",
"""    const goAhead = await confirmDialog({
      title: t('account.deleteWarn'),
      message: warning,
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!goAhead) return;""", 1)
io.open(p,'w',encoding='utf-8').write(s); print('profile dialog replaced')
