## Despliegue

Regla de ciclo de vida de R2 (borra los logs de búsqueda a los 30 días):

    npx wrangler r2 bucket lifecycle add catalogo-mcp-logs --name expire-busquedas --prefix busquedas/ --expire-days 30
