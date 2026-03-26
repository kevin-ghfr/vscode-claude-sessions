# Changelog

## 0.6.0 — 2026-03-17

### Corrections majeures
- **Snippets** : injection fiable dans la boite de texte via piggyback sur le message `session`
- **Resume session** : kill+relance ne tente plus de reprendre un ID de session mort (tracking par session ID)
- **Clic droit sessions** : "Injecter pre-commande" et "Envoyer message" fonctionnent independamment du reglage global
- **Paste mode** : Enter supplementaire apres envoi de texte long pour confirmer le paste dans Claude CLI
- **Ajouter projet** : lance maintenant une session Claude automatiquement
- **Pre-commande** : s'execute AVANT tmate (etait apres)
- **Init message** : envoye dans le terminal directement (etait textarea)
- **Scope editors** : fichiers filtres par projet (ne melange plus entre sessions)

### Reglages
- Nouveau reglage "Filtre projets" (Tous/Actifs/Focus) dans le panneau
- Scope sessions par defaut : "Espace focus" (etait "Toutes")
- Reglages reordonnes par categorie : Projets, Sessions, Espaces, Divers
- Volume retire des reglages (non fiable)
- Commandes notification cachees du palette

### Architecture
- `restoreGroup` et `focusOrRestoreGroup` sont async (await createSession)
- `createSession` est async (supporte QuickPick pour choix nouveau/reprendre)
- AutoSave supprime (complexite inutile)
- Nouvelles sessions auto-ajoutees a l'espace actif focus
- Context menu corrige : items sessions ne s'affichent plus sur les espaces
- `fireChanged` debounce 200ms (etait 50ms) pour reduire le flickering

## 0.5.0

- Snippets (commandes + messages pre-enregistres)
- Pre-commande et message init au lancement
- Espaces multi-actifs avec focus
- Scope sessions par espace
- Editeurs par session (scope editors)
- Plein ecran terminal
- tmate integration
- Son de notification configurable
