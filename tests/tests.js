const test = require('blue-tape')
const r = require('rethinkdb')
const testUtils = require('rethink-event-sourcing/tape-test-utils.js')
const crypto = require('crypto')

test('User service', t => {
  t.plan(7)

  let conn

  testUtils.connectToDatabase(t, r, (connection) => conn = connection)

  const admin = {
    roles: ["admin"]
  }

  let userId

  t.test('create user', t => {
    t.plan(2)

    testUtils.runCommand(t, r, 'users', {
      type: 'UserCreate',
      client: admin
    }, (cId) => { }).then(
      result => {
        userId = result
      }
    )

    t.test('check if user exists', t=> {
      t.plan(2)
      setTimeout(()=>{
        r.table('users_User').get(userId).run(conn).then(
          userRow => {
            if(userRow) t.pass('user exists')
              else t.fail('user not found')
            t.equals(userRow.display, 'unknown', 'user display name unknown')
          }
        ).catch(t.fail)
      }, 450)
    })

  })

  let email = "lmTestEmail_" + (Math.random() * 1000000) + "@test.com"

  t.test('add email login method', t => {
    t.plan(3)

    testUtils.pushEvents(t, r, 'users', [
      {
        type: "loginMethodAdded",
        user: userId,
        method: {
          type: 'emailPassword',
          email: email,
          id: email
        }
      }
    ])

    t.test('check if method is added', t=> {
      t.plan(5)
      setTimeout(()=>{
        r.table('users_User').get(userId).run(conn).then(
          user => {
            t.pass('user exists')
            t.equal(user.loginMethods.length, 1, 'one login method found')
            t.equal(user.loginMethods[0].type, 'emailPassword', 'one login method type match')
            t.equal(user.loginMethods[0].id, email, 'one login method id match')
            t.equal(user.loginMethods[0].email, email, 'one login extra data match')
          }
        ).catch(t.fail)
      }, 250)
    })

    t.test('check if display name is changed', t=> {
      t.plan(1)
      setTimeout(()=>{
        r.table('users_User').get(userId).run(conn).then(
          user => {
            t.equal(user.display, email, 'display name generated correctly')
          }
        ).catch(t.fail)
      }, 250)
    })

  })

  t.test('remove email login method', t => {
    t.plan(3)

    testUtils.pushEvents(t, r, 'users', [
      {
        type: "loginMethodRemoved",
        user: userId,
        method: {
          type: 'emailPassword',
          email: email,
          id: email
        }
      }
    ])

    t.test('check if method is removed', t=> {
      t.plan(2)
      setTimeout(()=>{
        r.table('users_User').get(userId).run(conn).then(
          user => {
            t.pass('user exists')
            t.equal(user.loginMethods.length, 0, 'zero login methods found')
          }
        ).catch(t.fail)
      }, 250)
    })

    t.test('check if display name is changed', t=> {
      t.plan(1)
      setTimeout(()=>{
        r.table('users_User').get(userId).run(conn).then(
          user => {
            t.equal(user.display, 'unknown', 'display name generated correctly')
          }
        ).catch(t.fail)
      }, 250)
    })

  })

  t.test('update user', t => {
    t.plan(2)

    testUtils.runCommand(t, r, 'users', {
      type: 'UserUpdate',
      client: admin,
      parameters: {
        user: userId,
        roles: ['test_object']
      }
    }, (cId) => { }).then(
      result => {
      }
    )

    t.test('check if user roles is changed', t => {
      t.plan(1)
      setTimeout( () => {
        r.table('users_User').get(userId).run(conn).then(
          user => {
            t.deepEqual(user.roles, [ 'test_object' ], 'roles are updated correctly')
          }
        ).catch( t.fail )
      }, 250)
    })

  })

  t.test('remove user', t => {
    t.plan(2)

    testUtils.runCommand(t, r, 'users', {
      type: 'UserDelete',
      parameters: {
        user: userId
      },
      client: admin
    }, (cId) => { }).then(
      result => {
      }
    )

    t.test('check if user not exists', t=> {
      t.plan(1)
      setTimeout(()=>{
        r.table('users_User').get(userId).run(conn).then(
          userRow => {
            if(!userRow) t.pass('user not exists')
              else t.fail('user still exists')
          }
        ).catch(t.fail)
      }, 250)
    })

  })

  t.test('close connection', t => {
    conn.close(() => {
      t.pass('closed')
      t.end()
    })
  })

})