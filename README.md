# Mon Bureau - Backend

Backend Node.js pour l'application Mon Bureau PWA.

## Architecture

- **Stateless** : aucun token n'est stocké côté serveur
- Les tokens Google OAuth sont stockés dans le **localStorage du frontend**
- Le frontend envoie les tokens à chaque requête via le header `Authorization: Bearer <base64>`

## Variables d'environnement

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://mon-bureau-backend.onrender.com/auth/google/callback
PORT=3000
```

## Déploiement sur Render

1. Push ce repo sur GitHub
2. Connecte le repo dans Render dashboard
3. Configure les variables d'environnement
4. Deploy !

## URL de redirection Google

Dans Google Cloud Console, ajoute cette URL dans les **Authorized redirect URIs** :
```
https://TON-APP.onrender.com/auth/google/callback
```

## Routes API

### Auth
- `GET /auth/google/url` - Génère l'URL de connexion Google
- `GET /auth/google/callback` - Callback OAuth (utilisé par Google)

### Calendar (auth requise via header)
- `GET /calendar/events` - Liste les événements
- `POST /calendar/events` - Crée un événement
- `DELETE /calendar/events/:eventId` - Supprime un événement

### Drive (auth requise via header)
- `GET /drive/files` - Liste les fichiers
- `GET /drive/search?q=...` - Recherche
- `POST /drive/upload` - Upload un fichier

### Health
- `GET /` - Info backend
- `GET /health` - Health check
