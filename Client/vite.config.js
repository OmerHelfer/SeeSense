import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: [
      '4fbd-2a0d-6fc2-4fd0-2800-241c-911-6bc8-6fb.ngrok-free.app'
    ]
  }
})