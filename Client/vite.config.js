import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: [
      '6204-2a0d-6fc0-993-4700-81ac-3ea7-dbd1-e0dc.ngrok-free.app'
    ]
  }
})