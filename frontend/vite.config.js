import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Quote API -> Travity quote server (Express on :8080)
      '/api': { target: 'http://127.0.0.1:8080' },
      '/quote': { target: 'http://127.0.0.1:8080' },
    },
  },
  build: {
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@walletconnect') || id.includes('@coinbase') || id.includes('@base-org') || id.includes('ethers')) return 'wallet';
          if (id.includes('genlayer-js') || id.includes('viem') || id.includes('}/ox/') || id.includes('node_modules/ox/')) return 'genlayer';
          if (id.includes('node_modules/react') || id.includes('react-router') || id.includes('@phosphor-icons')) return 'react';
        },
      },
    },
  },
})