# SIMEL CLI

Atajos para ejecutar el proyecto en tres modos:

## 1) Batch

Revisa por defecto **todas las empresas activas** en Airtable.

```bash
npm run simel:batch
```

Si querés limitarlo solo a las que tengan marcado `Ejecutar batch`:

```bash
node simel-cli.js batch --solo-marcados true
```

## 2) Consulta puntual por empresa

Busca la empresa en Airtable, toma usuario/password de SIMEL y consulta si hay manifiestos pendientes.

```bash
npm run simel:check -- --empresa "United"
```

## 3) Aprobar manifiestos por empresa

Busca la empresa en Airtable y ejecuta la aprobación automática.

```bash
npm run simel:approve -- --empresa "United"
```

## Variables requeridas

Para los modos que usan Airtable:

- `AIRTABLE_TOKEN`
- `AIRTABLE_BASE_ID`

Para la automatización SIMEL ya se obtienen usuario/password desde Airtable.

## Notas

- `simel-check.js` y `simel-approve.js` siguen sirviendo para ejecución directa con `SIMEL_USER` y `SIMEL_PASS`.
- `simel-cli.js` agrega un entrypoint único para operar por empresa o por batch.
