# Mini r/place

Une grille de 500×500 pixels partagée en temps réel, avec 16 couleurs, une base de données et « qui a posé ce pixel ».

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
3. Choisis une couleur, puis appuie sur **Placer**.

- Molette : zoomer
- Cliquer-glisser : se déplacer
- Échap : annuler la sélection

## La base de données

Tout est enregistré dans le fichier `place.db` (SQLite) :

- table `pixels` : l'historique complet, une ligne par pixel posé (position, couleur, pseudo, IP, date) → permet de faire un timelapse plus tard
- table `canvas` : l'état actuel de chaque case

Au démarrage, le serveur recharge la toile depuis la base : rien n'est perdu quand il redémarre.
Pour repartir de zéro, arrête le serveur et supprime `place.db`, `place.db-wal` et `place.db-shm`.

Pour regarder dedans, tu peux utiliser [DB Browser for SQLite](https://sqlitebrowser.org) (gratuit, Mac/Windows).

## Réglages (dans `server.js`)

- `WIDTH` / `HEIGHT` : taille de la grille
- `COOLDOWN_MS` : délai entre deux pixels (5 s par défaut ; 5 minutes = `300000`)
- `PALETTE` : les couleurs

## Limites actuelles

- Le pseudo n'est pas protégé par un mot de passe : quelqu'un peut prendre le même pseudo qu'un autre.
- Le délai est compté par adresse IP (tout un Wi-Fi le partage).

Prochaines étapes possibles : connexion avec Discord/Google, timelapse, modération.

## Mettre en ligne

Le fichier `place.db` doit être sur un disque permanent : sur Railway, ajoute un volume et définis la variable `DB_FILE=/data/place.db` (si le volume est monté sur `/data`).
