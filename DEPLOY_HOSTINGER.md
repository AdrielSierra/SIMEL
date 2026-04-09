# Deploy SIMEL en VPS de Hostinger + operación por WhatsApp

## Objetivo
Levantar el backend SIMEL en una VPS para operar por WhatsApp usando el webhook de Meta.

## Requisitos

- VPS Linux en Hostinger
- Docker instalado (recomendado)
- Un dominio o subdominio apuntando a la VPS
- HTTPS activo (Nginx + Let's Encrypt o proxy equivalente)
- App de Meta WhatsApp Cloud configurada

## Variables de entorno necesarias

```env
PORT=8080
AIRTABLE_TOKEN=...
AIRTABLE_BASE_ID=...
WHATSAPP_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_VERIFY_TOKEN=...
WHATSAPP_API_VERSION=v22.0
SIMEL_AUTO_APPROVE=false
```

## Opción recomendada: Docker

### Archivos ya preparados
- `.env.example`
- `docker-compose.yml`
- `Dockerfile`

### 1. Crear `.env`
```bash
cp .env.example .env
nano .env
```

### 2. Levantar con Compose
```bash
docker compose up -d --build
```

### 3. Ver logs
```bash
docker compose logs -f
```

### Alternativa manual con `docker run`
```bash
docker build -t simel-bot .
docker run -d \
  --name simel-bot \
  --restart unless-stopped \
  -p 8080:8080 \
  --env-file .env \
  simel-bot
```

## Reverse proxy Nginx

Ejemplo para `simel.tudominio.com`:

```nginx
server {
    server_name simel.tudominio.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Luego:
```bash
sudo certbot --nginx -d simel.tudominio.com
```

## Webhook de Meta

En Meta Developers configurar:

- **Webhook URL:**
  `https://simel.tudominio.com/whatsapp/webhook`
- **Verify token:**
  el mismo valor de `WHATSAPP_VERIFY_TOKEN`

## Endpoints útiles

- `GET /health`
- `GET /check?user=...&pass=...`
- `POST /batch/run`
- `GET /jobs/simel/ultimo`
- `POST /whatsapp/webhook`
- `GET /whatsapp/webhook`

## Flujo por WhatsApp

Una vez desplegado, el bot puede:

- consultar empresas (`empresa UNITED`)
- ver pendientes (`manifiestos pendientes`)
- pedir aprobación (`aprobar empresa DHL`)
- mostrar jobs (`simel estado`)

## Recomendaciones de endurecimiento

- no exponer el puerto 8080 directo a internet; usar Nginx
- usar HTTPS obligatorio
- guardar variables sensibles fuera del repo
- correr con usuario no root si salís de Docker
- habilitar firewall permitiendo solo 80/443 y SSH restringido

## Siguiente mejora recomendada

Agregar un endpoint/admin mode para revalidar aprobación consultando Pendientes refrescado + Historial si la UI queda desfasada.
