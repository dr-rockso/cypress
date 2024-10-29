import React from 'react'
import { mount } from 'cypress/react18'
import App from './App.tsx'

it('works', () => {
  mount(<App />)
  cy.contains('Learn React')
})
