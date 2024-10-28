import { mount } from 'cypress/vue'
import HelloWorld from './HelloWorld.vue'

it('works', () => {
  // TODO: fix typings issue with mount
  mount(HelloWorld, {
    props: {
      msg: 'Hello!',
    },
  })

  cy.contains('Hello!')
})
