import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { createApiClient } from './api.js';
import './styles.css';
import {registerPwa} from './pwa.js';
createRoot(document.getElementById('root')!).render(<App api={createApiClient()}/>);
void registerPwa();
