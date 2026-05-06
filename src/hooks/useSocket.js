import { useEffect, useRef } from 'react'
import { io } from 'socket.io-client'

export function useSocket(dispatch, connections) {
  const socketRef = useRef(null)

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
    }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe when connections change
  useEffect(() => {
    const socket = socketRef.current
    if (!socket) return
    Object.keys(connections).forEach(id => socket.emit('subscribe', id))
  }, [connections])

  return socketRef
}
