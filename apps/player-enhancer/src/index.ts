import { injectStyles } from './styles/styles';
import { initInjector } from './core/injector';

// Self-bootstrap: runs immediately when loaded as <script type="module">
injectStyles();
initInjector();
