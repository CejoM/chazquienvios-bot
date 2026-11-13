const axios = require('axios');

class RatesService {
  constructor() {
    this.cache = {
      peru_paralelo_compra: 3.400,
      peru_paralelo_venta: 3.420,
      argentina_dolar_blue_promedio: 1560,
      argentina_dolar_cripto_promedio: 1654,
      ultima_sincronizacion: new Date().toISOString()
    };
    this.intervalMs = 5 * 60 * 1000; // Refresco cada 5 minutos
  }

  async fetchCuantoEstaElDolar() {
    try {
      const response = await axios.get('https://cuantoestaeldolar.pe/', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 8000
      });
      const html = response.data;
      const idx = html.indexOf('Paralelo');
      if (idx !== -1) {
        const sub = html.substring(idx, idx + 2500);
        const matchBuy = sub.match(/content_buy.*?(\d+\.\d{3})/);
        const matchSale = sub.match(/content_sale.*?(\d+\.\d{3})/);

        if (matchBuy && matchBuy[1]) {
          this.cache.peru_paralelo_compra = parseFloat(matchBuy[1]);
        }
        if (matchSale && matchSale[1]) {
          this.cache.peru_paralelo_venta = parseFloat(matchSale[1]);
        }
      }
    } catch (err) {
      console.warn('⚠️ [RatesService] No se pudo obtener CuantoEstaElDolar.pe, usando cache anterior:', err.message);
    }
  }

  async fetchDolarApi() {
    try {
      const [resBlue, resCripto] = await Promise.all([
        axios.get('https://dolarapi.com/v1/dolares/blue', { timeout: 6000 }).catch(() => null),
        axios.get('https://dolarapi.com/v1/dolares/cripto', { timeout: 6000 }).catch(() => null)
      ]);

      if (resBlue && resBlue.data && resBlue.data.compra && resBlue.data.venta) {
        this.cache.argentina_dolar_blue_promedio = Math.round((resBlue.data.compra + resBlue.data.venta) / 2);
      }

      if (resCripto && resCripto.data && resCripto.data.compra && resCripto.data.venta) {
        this.cache.argentina_dolar_cripto_promedio = Math.round((resCripto.data.compra + resCripto.data.venta) / 2);
      }
    } catch (err) {
      console.warn('⚠️ [RatesService] No se pudo obtener DolarApi.com, usando cache anterior:', err.message);
    }
  }

  async syncAll() {
    await Promise.all([this.fetchCuantoEstaElDolar(), this.fetchDolarApi()]);
    this.cache.ultima_sincronizacion = new Date().toISOString();
    console.log(`✅ [RatesService] Tasas actualizadas: Paralelo Venta ${this.cache.peru_paralelo_venta} | Paralelo Compra ${this.cache.peru_paralelo_compra} | Blue ${this.cache.argentina_dolar_blue_promedio} | Cripto ${this.cache.argentina_dolar_cripto_promedio}`);
    return this.cache;
  }

  startAutoSync(botEngine) {
    // Sincronización inmediata al arrancar
    this.syncAll().then(rates => {
      if (botEngine) botEngine.actualizarCotizaciones(rates);
    });

    // Tarea periódica de fondo
    setInterval(async () => {
      const rates = await this.syncAll();
      if (botEngine) botEngine.actualizarCotizaciones(rates);
    }, this.intervalMs);
  }

  getRates() {
    return this.cache;
  }
}

module.exports = new RatesService();
