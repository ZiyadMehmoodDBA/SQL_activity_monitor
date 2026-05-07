import { useEffect, useRef } from 'react'
import { io } from 'socket.io-client'

export function useSocket(dispatch, connections) {
  const socketRef    = useRef(null)
  const subscribedRef = useRef(new Set())  // track which IDs have been subscribed

  useEffect(() => {
    const socket = io()
    socketRef.current = socket

    socket.on('metrics', ({ connId, ...metrics }) => {
      dispatch({ type: 'UPDATE_METRICS', connId, metrics })
    })

    socket.on('poll_error', ({ connId, message }) => {
      console.error(`[poll_error] conn ${connId}:`, message)
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
      subscribedRef.current.clear()
    }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe only NEW connections — connections object changes every 2s (UPDATE_METRICS),
  // but we guard with subscribedRef so we never re-emit for already-subscribed IDs.
  useEffect(() => {
    const socket = socketRef.current
    if (!socket) return
    const ids = Object.keys(connections)
    ids.forEach(id => {
      if (!subscribedRef.current.has(id)) {
        socket.emit('subscribe', id)
        subscribedRef.current.add(id)
      }
    })
    // Prune IDs that have been removed
    for (const id of [...subscribedRef.current]) {
      if (!connections[id]) subscribedRef.current.delete(id)
    }
  }, [connections])

  return socketRef
}
