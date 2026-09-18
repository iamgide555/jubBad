import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter, withViewTransitions } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(),
    // Cross-fades the outgoing/incoming route rather than an instant swap —
    // the single cheapest "this feels like a real app" signal for a router
    // that otherwise hard-cuts between every one of the ten routes.
    provideRouter(routes, withViewTransitions())
  ]
};
