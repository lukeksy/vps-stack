# VPS Stack — Guide de déploiement pour Claude

## Infrastructure

- **Hébergeur** : Ionos VPS
- **Domaine** : `delaale.fr`
- **OS** : Ubuntu (accès via SSH : `ssh alexis@ubuntu`)
- **Répertoire principal** : `~/vps-stack/`
- **Déploiement** : Git push depuis le PC → `git pull` sur le VPS

## Stack Docker Compose

Tous les services sont définis dans `~/vps-stack/docker-compose.yml` et lancés avec :

```bash
docker compose up -d
docker compose up -d --force-recreate <service>   # redémarrer un service spécifique
docker compose restart <service>
docker compose logs -f <service>
```

### Services existants

| Service    | Container     | Port interne | Description                        |
|------------|---------------|--------------|------------------------------------|
| Caddy      | `caddy`       | 80, 443      | Reverse proxy + TLS automatique    |
| n8n        | `n8n`         | 5678         | Workflow automation                 |
| PostgreSQL | `postgres`    | 5432         | Base de données n8n                |
| Ntfy       | `ntfy`        | 80           | Notifications push                  |
| OpenClaw   | `openclaw`    | 18789        | Interface assistant Claude          |

### Variables d'environnement

Stockées dans `~/vps-stack/.env`, chargées automatiquement par Docker Compose.
Variables actuellement utilisées :
- `TODOIST_TOKEN`
- `NOTION_TOKEN`
- `NOTION_BAYARD_TASKS_DB`
- `NOTION_TELEMANN_TASKS_DB`
- `ANTHROPIC_ADMIN_KEY`

## Caddy — Reverse proxy

### Fichier de config : `~/vps-stack/Caddyfile`

Caddy gère le TLS automatiquement pour tous les sous-domaines de `delaale.fr`.

### Appliquer une modification Caddyfile

```bash
# Après git pull sur le VPS :
docker compose up -d --force-recreate caddy
```

### Structure d'un bloc site

```caddy
monsite.delaale.fr {
    # (optionnel) auth basique
    handle /api/* {
        reverse_proxy monservice:PORT {
            header_up Host {host}
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
        }
    }
    handle {
        basic_auth {
            alexis $2a$14$Zfgrr5aW11uVGe6u0OD9hOOrXPtmTsTkCXA3ms8dUMSOPcSxSXYze
        }
        root * /srv/monsite
        file_server
        encode gzip
    }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "SAMEORIGIN"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
    log {
        output file /var/log/caddy/monsite.log
        format json
    }
}
```

> **Important** : les blocs `handle` plus spécifiques (`handle /api/*`) doivent toujours être déclarés **avant** le bloc générique (`handle { }`).
> Le `basic_auth` doit être placé **dans** le bloc `handle { }` des fichiers statiques, pas au niveau du bloc site — sinon les appels `fetch()` du navigateur sont bloqués.

### Hash du mot de passe Caddy

Le hash existant correspond au mot de passe d'Alexis :
```
$2a$14$Zfgrr5aW11uVGe6u0OD9hOOrXPtmTsTkCXA3ms8dUMSOPcSxSXYze
```

Pour générer un nouveau hash :
```bash
docker exec caddy caddy hash-password --plaintext "motdepasse"
```

## Déployer un nouveau site statique

### 1. Créer le dossier du site

Les fichiers statiques sont servis depuis `/srv/<nom-du-site>/` à l'intérieur du container Caddy.
Ce dossier est monté via un volume Docker dans `docker-compose.yml`.

Ajouter dans `docker-compose.yml` sous le service `caddy` → `volumes` :
```yaml
- ./monsite:/srv/monsite:ro
```

### 2. Créer les fichiers du site

Créer le dossier `~/vps-stack/monsite/` avec au minimum un `index.html`.

### 3. Ajouter le bloc dans le Caddyfile

```caddy
monsite.delaale.fr {
    handle {
        root * /srv/monsite
        file_server
        encode gzip
    }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
    }
    log {
        output file /var/log/caddy/monsite.log
        format json
    }
}
```

### 4. Déployer

```bash
# Sur le PC
git add .
git commit -m "feat: nouveau site monsite"
git push

# Sur le VPS
cd ~/vps-stack
git pull
docker compose up -d --force-recreate caddy
```

## Déployer un nouveau service Docker

### 1. Ajouter le service dans `docker-compose.yml`

```yaml
  monservice:
    image: monimage:tag
    container_name: monservice
    restart: unless-stopped
    environment:
      - MA_VARIABLE=${MA_VARIABLE}
    volumes:
      - monservice_data:/data
    networks:
      - vps-network
```

Et ajouter le volume en bas du fichier si nécessaire :
```yaml
volumes:
  monservice_data:
```

### 2. Exposer via Caddy

Ajouter un bloc dans le Caddyfile pointant vers `monservice:PORT`.

### 3. Déployer

```bash
git pull && docker compose up -d
```

## Volumes et chemins importants

| Chemin (dans container)          | Usage                                      |
|----------------------------------|--------------------------------------------|
| `/srv/brief/`                    | Fichiers statiques du dashboard brief      |
| `/srv/brief/data.json`           | Données générées par le workflow n8n       |
| `/home/node/brief-output/`       | Volume partagé n8n → Caddy pour data.json  |
| `/srv/todo/`                     | Fichiers statiques de l'app Todo           |
| `/var/log/caddy/`                | Logs Caddy par site                        |

Vérifier le contenu d'un fichier dans un container :
```bash
docker exec caddy cat /srv/brief/data.json
docker exec n8n cat /home/node/brief-output/data.json
```

## Sous-domaines existants

| Sous-domaine               | Service          | Auth         | Description                   |
|----------------------------|------------------|--------------|-------------------------------|
| `n8n.delaale.fr`           | n8n:5678         | n8n natif    | Workflow automation            |
| `todo.delaale.fr`          | todo-api:3000    | aucune       | App Todo (front + API)         |
| `assistant.delaale.fr`     | openclaw:18789   | basic_auth   | Interface OpenClaw             |
| `brief.delaale.fr`         | fichiers statiques| basic_auth  | Dashboard Morning Brief        |
| `ntfy.delaale.fr`          | ntfy:80          | aucune       | Notifications push             |

## Webhooks n8n accessibles depuis Caddy

Les webhooks n8n sont accessibles en interne via `n8n:5678`.
Pattern utilisé dans le Caddyfile pour proxifier :

```caddy
handle /mon-endpoint {
    rewrite * /webhook/mon-webhook-path
    reverse_proxy n8n:5678 {
        header_up Host n8n.delaale.fr
    }
}
```

Webhooks actifs sur `brief.delaale.fr` :
- `POST /trigger` → `n8n:5678/webhook/brief-refresh` (relance le workflow Morning Brief)
- `POST /brief-chat` → `n8n:5678/webhook/brief-chat` (chat OpenClaw dans le brief)

## n8n — Bonnes pratiques

- **Ne jamais réimporter le JSON complet** d'un workflow existant — cela oblige à revalider tous les credentials OAuth. Fournir uniquement les snippets à coller dans les nœuds concernés.
- `require('fs')` est autorisé dans les Code nodes grâce à `NODE_FUNCTION_ALLOW_BUILTIN=fs` dans l'environnement n8n.
- `$env.VARIABLE` est bloqué dans les Code nodes — utiliser des credentials n8n (Header Auth, etc.) à la place.
- Accès aux données d'un nœud upstream : `$('Nom du nœud').all()` (pas `$node['Nom']`).

## Réseau Docker

Tous les services partagent le réseau `vps-network` (bridge).
Les containers se parlent par leur nom de service (ex: `n8n`, `caddy`, `ntfy`).
