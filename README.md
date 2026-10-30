# Carnet à deux

Un carnet partagé pour préparer le voyage et le consulter sur place. L'accueil présente les étapes en photos, avec leurs dates, leurs nuits et les repères de prix disponibles.

Une page dédiée à chaque étape réunit le séjour, les hôtels, les adresses et les notes. Les fiches d'hôtels affichent photo, prix par nuit, projection pour le séjour, chambre, confort et emplacement. Un comparatif permet de confronter deux ou trois hôtels. Les prix historiques conservent leur contexte et ne deviennent pas des offres actuelles. Les informations absentes restent explicites.

La carte s'ouvre à la demande. Elle regroupe les repères proches à l'écran et les sépare au zoom. Elle propose un cadrage du voyage, de l'étape ou de sa liaison. Chaque étape peut avoir une photo avec son crédit, une description d'ambiance et les préférences des deux personnes.

Les vols indiquent les horaires locaux, les fuseaux, la durée et les voyageurs. Les horaires peuvent rester vides tant qu'ils ne sont pas confirmés. Le shopping distingue les envies personnelles et communes, les prix par devise, les achats et le matériel déjà possédé.

La vue Agenda affiche les idées de chaque journée : restaurants, boutiques, expositions, lieux et événements. Une idée peut rester sans date. Elle apparaît alors parmi les envies disponibles pendant l'étape. Les heures sont locales ; une soirée qui finit après minuit reste visible le lendemain. Chaque personne retrouve sa liste, avec une liste commune.

GitHub Pages sert le site. Un Cloudflare Worker et D1 conservent le carnet. Le code est public. Les données et les codes d'accès restent hors du dépôt.

## Essayer sur cet ordinateur

Prérequis : Node.js 22.13 ou plus récent, avec `node:sqlite`. Aucun paquet n'est nécessaire pour le site ou les tests du noyau.

```sh
npm test
npm run dev
```

Ouvre le lien dans `.private/dev-invitation.txt`. Le serveur écoute sur `127.0.0.1:4173`. Il utilise `.private/dev.sqlite`. Les modifications locales ne rejoignent pas automatiquement la production.

Si `.private/initial.json` existe, il initialise uniquement une base encore vide. Les prochains démarrages conservent les modifications. Sans ce fichier, le carnet démarre vide.

## Publier

Prérequis : Git, GitHub CLI connecté au compte propriétaire et un compte Cloudflare avec Workers, D1 et un sous-domaine workers.dev actif.

Si les comptes ne sont pas connectés :

```sh
gh auth login
npx wrangler login
```

Puis :

```sh
node tools/deploy.mjs --check
npm run deploy
```

Le contrôle `--check` lit les comptes sans créer de ressources. La publication lance les tests et contrôle les fichiers publics. Le script crée le dépôt public `carnet-a-deux`, le Worker `carnet-a-deux-sync` et une base D1. Il publie le code sur `main` et le site sur `gh-pages`, puis vérifie la construction et la configuration servie.

Le script utilise les connexions existantes. Il accepte aussi `GH_TOKEN` et `CLOUDFLARE_API_TOKEN` dans l'environnement. Ne mets jamais ces valeurs dans le code, les paramètres de commande ou le dépôt. Si plusieurs comptes Cloudflare existent, précise `CLOUDFLARE_ACCOUNT_ID`. Pour un autre nom de dépôt neuf, utilise `GITHUB_REPO`.

Le script refuse de remplacer des ressources existantes sans lien avec sa publication. `.private/deployment.json` permet de reprendre une publication interrompue. Si une création distante a été interrompue sans confirmation, vérifie la ressource avant toute nouvelle tentative. Aucune suppression automatique n'est effectuée. Le script ne change pas l'abonnement des comptes utilisés.

Si un fichier privé `.private/enrichment.json` a été préparé, cette commande publie aussi ses photos, descriptions, hôtels historiques, projets de vols et pistes shopping :

```sh
npm run deploy -- --enrich
```

Ces ajouts complètent les champs vides et conservent les fiches existantes. Une sauvegarde privée précède l'écriture. Une modification simultanée interrompt l'ajout sans écraser l'autre version. Le journal permet de reprendre après une coupure. Le même fichier n'est appliqué qu'une fois : une envie supprimée ensuite ne revient pas à la publication suivante.

Le Worker est publié avant l'interface. Les contenus privés sont ajoutés après le contrôle de la publication GitHub Pages. Les anciens carnets sont migrés à l'ouverture, avec leurs brouillons. Une ancienne interface ne peut pas écraser les nouveaux champs ; recharge la page si elle demande une mise à jour.

## Partager le carnet

Après la publication, récupère le lien dans `.private/invitation.txt`, ou copie-le depuis « Le carnet » dans le site. Ce lien permet de lire et de modifier le même carnet depuis un autre appareil.

Le code reste dans le fragment du lien et la session du navigateur. Il est retiré de l'adresse dès l'ouverture. Les notes et les exports ne contiennent pas le code. Un export contient cependant les données privées : conserve-le hors du dépôt.

Les modifications indépendantes se fusionnent. Si deux personnes changent un même champ, le carnet garde le brouillon et demande quoi conserver. Les formulaires signalent aussi une modification distante avant son remplacement. En cas de coupure, un brouillon local reste disponible. « Enregistré en ligne » indique que le service a confirmé la sauvegarde.

## Fichiers et vérification

- `public/` : site sans données personnelles.
- `worker/` : API et migration D1.
- `tools/` : serveur local, build et publication.
- `tests/` : tests du noyau et de la séparation des fichiers publics.
- `.private/` : données initiales, base locale, invitations et état de publication. Ignoré par Git.

La carte utilise MapLibre et le fond vectoriel OpenFreeMap, issu des données OpenStreetMap. Aucun compte de facturation ni clé API ne sont nécessaires. Les boutons Google Maps ouvrent la recherche ou la navigation dans un autre onglet. Les lignes entre étapes sont schématiques. Sources et licences : `public/vendor/SOURCES.md`.

Les tests locaux ne prouvent pas le déploiement Cloudflare ou GitHub Pages. La publication doit réussir et être relue avant d'annoncer une version en ligne. Les prix, horaires et disponibilités ajoutés au carnet restent à vérifier.
