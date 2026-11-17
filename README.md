# Mini r/place

Une grille de 500×500 pixels partagée en temps réel, avec 32 couleurs, un timelapse, un classement, des annonces et des événements, une base de données, « qui a posé ce pixel », un chat et des outils de modération.

## Lancer en local

Il faut [Node.js](https://nodejs.org) (version 18 ou plus).

```bash
npm install
npm start
```

Ouvre ensuite http://localhost:3000.

## Comment jouer

1. Choisis un pseudo (il s'affiche sur chaque pixel que tu poses ; clique dessus en haut pour le changer).
2. Clique sur un pixel pour le sélectionner : tu vois qui l'a posé, quand, et combien de pixels cette personne a posés au total.
3. Appuie sur **Placer un pixel**, choisis une couleur, puis ✓.

**Au clavier (ordinateur)** : survole un pixel avec la souris et appuie sur la lettre de la couleur (A Z E R T Y U I / Q S D F G H J K sur un clavier français) : le pixel est posé directement. Les flèches déplacent le viseur, Entrée pose, Échap annule.

- Molette : zoomer
- Cliquer-glisser : se déplacer
- Échap : annuler la sélection

## Timelapse

Bouton 🎬 en haut (ou adresse `/timelapse`) : rejoue toute l'histoire de la toile.
Choisis la durée, puis « 📹 Créer la vidéo » pour télécharger une vidéo verticale (TikTok) ou carrée.

## Classement

Bouton 🏆 en haut : les 20 joueurs qui ont posé le plus de pixels, sur 24 heures ou depuis le début.

## Annonces et événements (modération)

- **📢 Annonce** : un message affiché en haut pour tout le monde (chacun peut le masquer).
- **🎉 Événement** : un nom, une date de début et de fin, un délai spécial pendant l'événement (facultatif)
  et l'option « toile fermée avant et après ». Un compte à rebours s'affiche pour tout le monde.

## Le chat

En bas à gauche (en haut sur téléphone). Clique sur « 💬 Chat » pour l'ouvrir ou le réduire.
Messages de 200 caractères maximum, un message toutes les 1,5 seconde.

## La modération

1. Définis la variable d'environnement `ADMIN_PASSWORD` (sur Railway : onglet **Variables**). Sans elle, la modération est désactivée.
2. Sur le site, clique sur le bouclier 🛡️ en haut et entre le mot de passe.

Tu peux alors :
- **Supprimer un message** : 🗑️ à côté du message
- **Bannir quelqu'un** : 🚫 à côté de son message, bouton « Bannir » quand tu cliques sur un de ses pixels, ou le formulaire du panneau. Le pseudo et toutes les adresses IP qu'il a utilisées sont bannis : il peut encore regarder, mais plus dessiner ni écrire.
- **Annuler les pixels d'un pseudo** : chaque case qu'il a coloriée reprend la couleur d'avant
- **Effacer une zone** : sélectionne un pixel puis « ← sélection » pour chaque coin, et « Effacer la zone » (remise en blanc)
- **Débannir** : liste « Bannis » dans le panneau

En modération, tu n'as pas de délai entre deux pixels et tes messages ont un badge MODO.
Toutes les actions sont enregistrées dans la table `mod_log`.

## La base de données

Tout est enregistré dans le fichier `place.db` (SQLite) :

- table `pixels` : l'historique complet, une ligne par pixel posé (position, couleur, pseudo, IP, date) → permet de faire un timelapse plus tard
- table `canvas` : l'état actuel de chaque case
- tables `chat`, `bans` et `mod_log` : messages, bannissements et journal de modération

Au démarrage, le serveur recharge la toile depuis la base : rien n'est perdu quand il redémarre.
Pour repartir de zéro, arrête le serveur et supprime `place.db`, `place.db-wal` et `place.db-shm`.

Pour regarder dedans, tu peux utiliser [DB Browser for SQLite](https://sqlitebrowser.org) (gratuit, Mac/Windows).

## Réglages (dans `server.js`)

- `WIDTH` / `HEIGHT` : taille de la grille
- `COOLDOWN_MS` : délai entre deux pixels (1 s par défaut ; 5 minutes = `300000`)
- `PALETTE` : les couleurs

## Limites actuelles

- Le pseudo n'est pas protégé par un mot de passe : quelqu'un peut prendre le même pseudo qu'un autre.
- Le délai est compté par adresse IP (tout un Wi-Fi le partage).

Prochaines étapes possibles : connexion avec Discord/Google, timelapse.

## Mettre en ligne

Le fichier `place.db` doit être sur un disque permanent : sur Railway, ajoute un volume et définis la variable `DB_FILE=/data/place.db` (si le volume est monté sur `/data`).

## Historique des versions

Le numéro de version s'affiche en bas à droite du site.

- **v0.09** : timelapse avec export vidéo, classement, annonces, événements, 32 couleurs (les anciens pixels sont convertis automatiquement)
- **v0.08** : correction, la pose au clavier suit le viseur après un déplacement avec les flèches
- **v0.07** : touches des couleurs modifiables par chaque joueur
- **v0.06** : délai d'1 seconde, pose directe avec les lettres du clavier
- **v0.05** : effacer une zone en la dessinant, confirmations dans la page
- **v0.04** : placement comme le vrai r/place (viseur, bulle, palette ✕/✓, zoom à deux doigts, flèches)
- **v0.03** : chat et outils de modération
- **v0.02** : base de données SQLite et « qui a posé ce pixel »
- **v0.01** : première version (grille partagée en temps réel)
