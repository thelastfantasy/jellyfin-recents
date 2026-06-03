import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: { queries: { gcTime: 10 * 60 * 1000, staleTime: Infinity } },
})
